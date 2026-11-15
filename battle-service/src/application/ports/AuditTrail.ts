/** What happened to a request (SEG-2), with the same names users-service stores. */
export type AuditOutcome = "ok" | "failed" | "rejected" | "rate_limited" | "blocked" | "error";

export type AuditUserKind = "user" | "guest" | "anonymous";

/**
 * One request to the backend as this service handled it (SEG-2, non-repudiation): who made it (from
 * the validated token, never from what the client claims), from where (address behind the trusted
 * proxies, browser), what they did and how it ended. The time, the event id and the service are
 * added by the adapter; users-service adds the region and chains the record.
 */
export interface AuditEntry {
  /** "socket:handshake", or the client event ("vote:cast", "word:submit"...). */
  action: string;
  /** The room the action was about, when there is one. */
  resource?: string;
  outcome: AuditOutcome;
  /** Error code or rejection reason (PLAYER_NOT_IN_ROOM, expired_token...). */
  code?: string;
  /** A few safe facts about the action (whom the vote was for, which player was kicked...). */
  detail?: string;
  userId?: string;
  userKind: AuditUserKind;
  userName?: string;
  ip: string;
  userAgent?: string;
  correlationId?: string;
}

/**
 * Outbound port of the audit trail. `record` never throws and never waits: it is called on the hot
 * path of every Socket.IO event, so the adapter queues the entry and delivers it in the background.
 */
export interface AuditTrail {
  record(entry: AuditEntry): void;
}

/** Records nothing; for harnesses and as the default. */
export const noopAuditTrail: AuditTrail = {
  record() {},
};
