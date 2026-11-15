import type { Socket } from "socket.io";
import { AuthError, type TokenVerifier } from "../../application/auth/AuthIdentity.js";
import type { Logger } from "../../application/ports/Logger.js";
import { noopAuditTrail, type AuditTrail } from "../../application/ports/AuditTrail.js";
import { socketActor } from "../audit/socketAudit.js";
import { CORRELATION_HEADER, correlationIdFrom, type AuthAuditLog } from "../auth/authAudit.js";
import { rootLogger } from "../logging/logger.js";
import type { SocketData } from "./events.js";

/** Audit action of opening a Socket.IO connection (SEG-2). */
export const HANDSHAKE_ACTION = "socket:handshake";

/** Socket.IO middleware run once per connection, before the "connection" event. */
export type HandshakeAuthenticator = (
  socket: Socket<never, never, never, SocketData>,
  next: (error?: Error & { data?: unknown }) => void,
) => void;

export interface HandshakeAuthDependencies {
  verifier: TokenVerifier;
  audit: AuthAuditLog;
  /** Default: the process logger. */
  logger?: Logger;
  /** SEG-2: every refused handshake is a non-repudiation record too. Default: none. */
  trail?: AuditTrail;
  /** Proxies whose X-Forwarded-For entry is trusted, to record the client's address (SEG-2). */
  trustedProxyHops?: number;
}

/**
 * Authenticates the Socket.IO handshake (SEG-1). The client sends its token in
 * the handshake (`io(url, { auth: { token } })`); it is validated before the
 * connection is accepted, so a socket without a valid token never reaches the
 * "connection" handlers and can never be bound to a room. It is refused with
 * the error UNAUTHORIZED (the client's `connect_error`), and the attempt is
 * logged with its correlation id, never with the token.
 *
 * It lives here and not in the api-gateway because the gateway only proxies the
 * connection: it cannot read the handshake payload.
 */
export function createHandshakeAuth({
  verifier,
  audit,
  logger = rootLogger,
  trail = noopAuditTrail,
  trustedProxyHops = 0,
}: HandshakeAuthDependencies): HandshakeAuthenticator {
  return (socket, next) => {
    const correlationId = correlationIdFrom(socket.handshake.headers[CORRELATION_HEADER]);
    socket.data.correlationId = correlationId;
    authenticate(verifier, socket.handshake.auth?.token).then(
      (identity) => {
        socket.data.auth = identity;
        next();
      },
      (error: unknown) => {
        const failure = error instanceof AuthError ? error : new AuthError("UNAUTHORIZED", "verifier_unavailable");
        if (!(error instanceof AuthError)) logger.error({ correlationId, err: error }, "Error validating a handshake token");
        audit.rejected({
          channel: "socket.io",
          code: failure.code,
          reason: failure.reason,
          correlationId,
          socketEvent: "handshake",
        });
        // An accepted handshake is recorded on "connection", once every middleware let it through.
        trail.record({
          ...socketActor(socket, trustedProxyHops),
          action: HANDSHAKE_ACTION,
          outcome: "rejected",
          code: failure.reason,
        });
        const refusal: Error & { data?: unknown } = new Error(failure.code);
        refusal.data = { code: failure.code, message: failure.message, correlationId };
        next(refusal);
      },
    );
  };
}

async function authenticate(verifier: TokenVerifier, token: unknown) {
  if (typeof token !== "string" || token.length === 0) throw new AuthError("UNAUTHORIZED", "missing_token");
  return verifier.verify(token);
}
