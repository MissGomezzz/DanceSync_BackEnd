import type { Server, Socket } from "socket.io";
import type { AbuseConfig } from "./abuseConfig.js";
import { TokenBucket, type Clock } from "./TokenBucket.js";

/** Code of the acknowledgement of a refused event, and of the `rate:limited` notice. */
export const RATE_LIMITED = "RATE_LIMITED";
export const RATE_LIMITED_EVENT = "rate:limited";

/** What the client receives in `rate:limited`. */
export interface RateLimitedPayload {
  code: typeof RATE_LIMITED;
  /** Events refused since the previous notice. */
  dropped: number;
  /** When the client can send again. */
  retryAfterMs: number;
}

/** One refused event, for the incident log and the temporary block (SEG-3). */
export interface DroppedEvent {
  socket: Socket;
  event: string;
  retryAfterMs: number;
}

export interface EventRateLimitOptions extends Pick<AbuseConfig, "eventsPerSecond" | "eventBurst"> {
  now?: Clock;
  /** At most one `rate:limited` notice per connection in this window. */
  noticeIntervalMs?: number;
  /** Called for every refused event. */
  onDropped?: (dropped: DroppedEvent) => void;
}

const MESSAGE = "Too many events: slow down and try again in a moment.";

/**
 * Limits the events of every Socket.IO connection with a token bucket (SEG-3).
 *
 * It runs as a socket middleware, before any event handler, so a refused event
 * never reaches the use cases and costs almost nothing. The refused event is
 * dropped; if it carried an acknowledgement it is answered at once with
 * `RATE_LIMITED`, so a client is not left waiting for its timeout, and the
 * client is told through `rate:limited`. That notice is sent at most once per
 * `noticeIntervalMs`: answering a flood with a flood of notices would help the
 * attacker.
 */
export function attachEventRateLimit(io: Server<any, any, any, any>, options: EventRateLimitOptions): void {
  const now = options.now ?? Date.now;
  const noticeIntervalMs = options.noticeIntervalMs ?? 1000;

  io.on("connection", (socket) => {
    const bucket = new TokenBucket(options.eventsPerSecond, options.eventBurst, now);
    let droppedSinceNotice = 0;
    let lastNoticeAt = Number.NEGATIVE_INFINITY;

    socket.use((packet, next) => {
      const { allowed, retryAfterMs } = bucket.take();
      if (allowed) return next();

      const [event, ...args] = packet;
      const ack = args.at(-1);
      if (typeof ack === "function") ack({ ok: false, error: { code: RATE_LIMITED, message: MESSAGE } });

      droppedSinceNotice += 1;
      const at = now();
      if (at - lastNoticeAt >= noticeIntervalMs) {
        const notice: RateLimitedPayload = { code: RATE_LIMITED, dropped: droppedSinceNotice, retryAfterMs };
        socket.emit(RATE_LIMITED_EVENT, notice);
        lastNoticeAt = at;
        droppedSinceNotice = 0;
      }
      options.onDropped?.({ socket, event: String(event), retryAfterMs });
    });
  });
}
