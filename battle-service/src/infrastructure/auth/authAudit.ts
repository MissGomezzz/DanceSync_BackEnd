import { randomUUID } from "node:crypto";
import type { AuthErrorCode, AuthFailureReason } from "../../application/auth/AuthIdentity.js";

/** One refused request or connection. It never carries the token, only why it was refused. */
export interface AuthRejection {
  channel: "http" | "socket.io";
  code: AuthErrorCode;
  reason: AuthFailureReason;
  /** Ties this line to the gateway's log and to the error the client received. */
  correlationId: string;
  /** HTTP: the method and path (without the query string). */
  method?: string;
  path?: string;
  /** Socket.IO: "handshake" or the client event that was refused. */
  socketEvent?: string;
}

/** Audit trail of refused authentication and authorization attempts (SEG-1). */
export interface AuthAuditLog {
  rejected(entry: AuthRejection): void;
}

/** One JSON line per rejection on stderr, picked up by the platform's log collector. */
export const consoleAuthAudit: AuthAuditLog = {
  rejected(entry) {
    console.warn(JSON.stringify({ level: "warn", event: "auth.rejected", at: new Date().toISOString(), ...entry }));
  },
};

export const CORRELATION_HEADER = "x-correlation-id";

const VALID_CORRELATION_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The correlation id set by the api-gateway, or a new one when the request did
 * not come through it. A value that is not a plain id is replaced, so nothing
 * a client sends can be injected into the log.
 */
export function correlationIdFrom(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && VALID_CORRELATION_ID.test(value) ? value : randomUUID();
}
