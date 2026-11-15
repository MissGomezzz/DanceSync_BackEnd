import type { Server, Socket } from "socket.io";
import type { Logger } from "../../application/ports/Logger.js";
import { rootLogger } from "../logging/logger.js";
import type { AbuseAuditLog, AbuseIncident } from "./abuseAudit.js";
import type { AbuseConfig } from "./abuseConfig.js";
import type { BlockList } from "./blockList.js";
import { clientAddress } from "./clientAddress.js";
import { attachEventRateLimit } from "./eventRateLimit.js";
import type { Clock } from "./TokenBucket.js";

/** `connect_error` message of a handshake refused because the client is blocked. */
export const BLOCKED = "BLOCKED";
/** Sent to a connection right before it is closed for flooding. */
export const RATE_BLOCKED_EVENT = "rate:blocked";

export interface RateBlockedPayload {
  code: typeof BLOCKED;
  /** When the client may connect again. */
  retryAfterMs: number;
}

export interface AbuseProtectionDependencies {
  config: AbuseConfig;
  blocks: BlockList;
  audit: AbuseAuditLog;
  now?: Clock;
  /** Operational errors (not incidents, those go to `audit`). Default: the process logger. */
  logger?: Logger;
}

interface ConnectionState {
  /** Times of the recent dropped events, oldest first. */
  drops: number[];
  droppedSinceLog: number;
  lastLoggedAt: number;
  blocked: boolean;
}

const LOG_INTERVAL_MS = 1000;

/**
 * SEG-3 on the Socket.IO server: the per-connection event limit, the temporary
 * block of clients that keep flooding, and the incident log.
 *
 * Register it after the authentication middleware (after
 * `registerSocketHandlers`), so the handshake check knows who is connecting.
 *
 * - A refused handshake answers `BLOCKED` while the client's identity or
 *   address is blocked. If the block list cannot be read the connection is
 *   accepted and the error is logged: a Redis outage must not lock everyone out.
 * - A connection with more than `strikeThreshold` dropped events within
 *   `strikeWindowSeconds` (more than a whole burst: a legitimate client that
 *   goes over for a moment loses a few events and never gets there) is blocked
 *   for `blockSeconds`, told through `rate:blocked`, and disconnected.
 */
export function attachAbuseProtection(io: Server<any, any, any, any>, deps: AbuseProtectionDependencies): void {
  const { config, blocks, audit } = deps;
  const logger = deps.logger ?? rootLogger;
  const now = deps.now ?? Date.now;
  const windowMs = config.strikeWindowSeconds * 1000;
  const blockMs = config.blockSeconds * 1000;
  const states = new WeakMap<Socket, ConnectionState>();

  const ipOf = (socket: Socket): string => {
    if (typeof socket.data.clientIp !== "string") {
      socket.data.clientIp = clientAddress(
        socket.handshake.address,
        socket.handshake.headers["x-forwarded-for"],
        config.trustedProxyHops,
      );
    }
    return socket.data.clientIp;
  };
  const playerOf = (socket: Socket): string | undefined => socket.data.auth?.playerId ?? socket.data.playerId;
  const keysOf = (socket: Socket): string[] => {
    const player = playerOf(socket);
    return [`ip:${ipOf(socket)}`, ...(player ? [`player:${player}`] : [])];
  };
  const incident = (socket: Socket, extra: Partial<AbuseIncident>): AbuseIncident => ({
    channel: "socket.io",
    correlationId: socket.data.correlationId,
    playerId: playerOf(socket),
    ip: ipOf(socket),
    ...extra,
  });

  io.use((socket, next) => {
    blocks.remainingMs(keysOf(socket)).then(
      (remaining) => {
        if (remaining <= 0) return next();
        audit.refused(incident(socket, { socketEvent: "handshake", blockedForMs: remaining }));
        const refusal: Error & { data?: unknown } = new Error(BLOCKED);
        refusal.data = {
          code: BLOCKED,
          message: "Too many events: try again in a moment.",
          retryAfterMs: remaining,
          correlationId: socket.data.correlationId,
        };
        next(refusal);
      },
      (error: unknown) => {
        logger.error({ correlationId: socket.data.correlationId, err: error }, "Could not read the abuse block list; accepting the connection");
        next();
      },
    );
  });

  attachEventRateLimit(io, {
    eventsPerSecond: config.eventsPerSecond,
    eventBurst: config.eventBurst,
    now,
    onDropped: ({ socket, event, retryAfterMs }) => {
      const at = now();
      let state = states.get(socket);
      if (!state) {
        state = { drops: [], droppedSinceLog: 0, lastLoggedAt: Number.NEGATIVE_INFINITY, blocked: false };
        states.set(socket, state);
      }
      if (state.blocked) return;

      state.drops.push(at);
      while (state.drops.length > 0 && state.drops[0] <= at - windowMs) state.drops.shift();
      state.droppedSinceLog += 1;
      if (at - state.lastLoggedAt >= LOG_INTERVAL_MS) {
        audit.limited(incident(socket, { socketEvent: event, dropped: state.droppedSinceLog, retryAfterMs }));
        state.lastLoggedAt = at;
        state.droppedSinceLog = 0;
      }

      if (state.drops.length > config.strikeThreshold) {
        state.blocked = true;
        void block(socket);
      }
    },
  });

  async function block(socket: Socket): Promise<void> {
    try {
      await blocks.block(keysOf(socket), blockMs);
    } catch (error) {
      logger.error({ correlationId: socket.data.correlationId, err: error }, "Could not store an abuse block; disconnecting the client anyway");
    }
    audit.blocked(incident(socket, { blockedForMs: blockMs }));
    const notice: RateBlockedPayload = { code: BLOCKED, retryAfterMs: blockMs };
    socket.emit(RATE_BLOCKED_EVENT, notice);
    socket.disconnect(true);
  }
}
