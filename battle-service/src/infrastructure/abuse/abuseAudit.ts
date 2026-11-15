/**
 * Incident log of the abuse protection (SEG-3): one JSON line per incident on
 * stderr, in the same shape as the authentication audit of SEG-1, so both can
 * be searched together by correlation id, player or address.
 */
export interface AbuseIncident {
  channel: "socket.io";
  correlationId?: string;
  playerId?: string;
  ip: string;
  /** The client event that was refused (rate_limited), or "handshake" (refused). */
  socketEvent?: string;
  /** Events refused since the previous rate_limited line of this connection. */
  dropped?: number;
  retryAfterMs?: number;
  /** How long the block lasts (blocked) or still lasts (refused). */
  blockedForMs?: number;
}

export interface AbuseAuditLog {
  /** Some events of a connection were dropped (at most one line per second and connection). */
  limited(incident: AbuseIncident): void;
  /** A connection kept flooding: it is blocked and disconnected. */
  blocked(incident: AbuseIncident): void;
  /** A blocked client tried to connect again. */
  refused(incident: AbuseIncident): void;
}

function line(event: string, incident: AbuseIncident): string {
  return JSON.stringify({ level: "warn", event, at: new Date().toISOString(), ...incident });
}

export const consoleAbuseAudit: AbuseAuditLog = {
  limited: (incident) => console.warn(line("abuse.rate_limited", incident)),
  blocked: (incident) => console.warn(line("abuse.blocked", incident)),
  refused: (incident) => console.warn(line("abuse.refused", incident)),
};
