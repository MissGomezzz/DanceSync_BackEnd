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
}

function readNumber(source: Source, name: string, fallback: number, { integer }: { integer: boolean }): number {
  const raw = source[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(
      `Environment variable ${name} must be a ${integer ? "whole number" : "number"} greater than 0, received "${raw}"`,
    );
  }
  return parsed;
}

export function loadAbuseConfig(source: Source = process.env): AbuseConfig {
  return {
    eventsPerSecond: readNumber(source, "RATE_LIMIT_EVENTS_PER_SECOND", 20, { integer: false }),
    eventBurst: readNumber(source, "RATE_LIMIT_EVENT_BURST", 40, { integer: true }),
  };
}
