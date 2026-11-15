/**
 * Audit trail settings (SEG-2). Kept apart from config/env.ts, like the Redis and abuse settings,
 * so each scenario's settings evolve on their own.
 */
type Source = Record<string, string | undefined>;

export interface AuditConfig {
  /** False only with AUDIT_ENABLED=false (tests, local experiments). */
  readonly enabled: boolean;
  /** users-service endpoint that chains the records. */
  readonly ingestUrl: string;
  /** Shared secret of the internal calls (AUDIT_INTERNAL_TOKEN); empty: records wait in memory. */
  readonly internalToken: string;
  readonly flushIntervalMs: number;
  readonly batchSize: number;
  /** Records kept while users-service cannot be reached; beyond it new ones are dropped and counted. */
  readonly bufferCapacity: number;
}

const MIN_SECRET_BYTES = 32;

function positiveInteger(source: Source, name: string, fallback: number): number {
  const raw = source[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a whole number greater than 0, received "${raw}"`);
  }
  return parsed;
}

export function loadAuditConfig(source: Source = process.env): AuditConfig {
  const internalToken = source.AUDIT_INTERNAL_TOKEN?.trim() ?? "";
  if (internalToken.length > 0 && Buffer.byteLength(internalToken, "utf8") < MIN_SECRET_BYTES) {
    throw new Error(`Environment variable AUDIT_INTERNAL_TOKEN must be at least ${MIN_SECRET_BYTES} bytes long`);
  }
  const usersServiceUrl = (source.USERS_SERVICE_URL ?? "http://localhost:8081").replace(/\/+$/, "");
  return {
    enabled: (source.AUDIT_ENABLED ?? "true").trim().toLowerCase() !== "false",
    ingestUrl: `${usersServiceUrl}/internal/audit/events`,
    internalToken,
    flushIntervalMs: positiveInteger(source, "AUDIT_FLUSH_INTERVAL_MS", 1000),
    batchSize: positiveInteger(source, "AUDIT_BATCH_SIZE", 200),
    bufferCapacity: positiveInteger(source, "AUDIT_BUFFER_CAPACITY", 20_000),
  };
}
