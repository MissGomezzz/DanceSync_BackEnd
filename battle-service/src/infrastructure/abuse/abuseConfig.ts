/**
 * Abuse and denial-of-service protection settings (SEG-3). Kept apart from
 * config/env.ts, like the Redis settings, so each scenario's settings evolve
 * on their own.
 */
type Source = Record<string, string | undefined>;

export interface AbuseConfig {
  /** Sustained events per second allowed on one Socket.IO connection. */
  readonly eventsPerSecond: number;
  /** Events a connection may send at once before the sustained rate applies. */
  readonly eventBurst: number;
  /** A connection with more than `strikeThreshold` dropped events within `strikeWindowSeconds` is blocked. */
  readonly strikeThreshold: number;
  readonly strikeWindowSeconds: number;
  /** How long a blocked client (its identity and its address) is refused. */
  readonly blockSeconds: number;
  /** Proxies in front of the service whose X-Forwarded-For entry is believed (0: none). */
  readonly trustedProxyHops: number;
}

interface Rule {
  integer: boolean;
  allowZero?: boolean;
}

function readNumber(source: Source, name: string, fallback: number, { integer, allowZero = false }: Rule): number {
  const raw = source[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  const tooSmall = allowZero ? parsed < 0 : parsed <= 0;
  if (!Number.isFinite(parsed) || tooSmall || (integer && !Number.isInteger(parsed))) {
    const kind = integer ? "whole number" : "number";
    throw new Error(`Environment variable ${name} must be a ${kind} ${allowZero ? "of 0 or more" : "greater than 0"}, received "${raw}"`);
  }
  return parsed;
}

export function loadAbuseConfig(source: Source = process.env): AbuseConfig {
  return {
    eventsPerSecond: readNumber(source, "RATE_LIMIT_EVENTS_PER_SECOND", 20, { integer: false }),
    eventBurst: readNumber(source, "RATE_LIMIT_EVENT_BURST", 40, { integer: true }),
    strikeThreshold: readNumber(source, "RATE_LIMIT_STRIKE_THRESHOLD", 40, { integer: true }),
    strikeWindowSeconds: readNumber(source, "RATE_LIMIT_STRIKE_WINDOW_SECONDS", 10, { integer: false }),
    blockSeconds: readNumber(source, "RATE_LIMIT_BLOCK_SECONDS", 30, { integer: false }),
    trustedProxyHops: readNumber(source, "TRUSTED_PROXY_HOPS", 0, { integer: true, allowZero: true }),
  };
}
