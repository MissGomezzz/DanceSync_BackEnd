/**
 * Redis settings (REN-1 / DIS-1). Kept apart from config/env.ts so the
 * authentication settings and these ones can evolve independently.
 *
 * Without REDIS_URL the service keeps the room and word race state in memory (a
 * single instance, as before). With it, the state lives in Redis and several
 * instances can serve the same rooms.
 */
type Source = Record<string, string | undefined>;

export interface RedisConfig {
  /** Empty: in-memory state. Otherwise redis:// or rediss:// URL. */
  readonly url: string;
  /** Safety net: a room or race key that is never touched again expires after this long. */
  readonly ttlSeconds: number;
  /** Attempts of an optimistic room update before giving up (see RedisRoomRepository). */
  readonly maxUpdateAttempts: number;
  /** Prefix of the Socket.IO adapter channels; instances must share it. */
  readonly adapterKey: string;
}

function readPositiveInteger(source: Source, name: string, fallback: number): number {
  const raw = source[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a whole number greater than 0, received "${raw}"`);
  }
  return parsed;
}

export function loadRedisConfig(source: Source = process.env): RedisConfig {
  const url = source.REDIS_URL?.trim() ?? "";
  if (url !== "" && !/^rediss?:\/\//i.test(url)) {
    throw new Error('Environment variable REDIS_URL must start with "redis://" or "rediss://"');
  }
  return {
    url,
    ttlSeconds: readPositiveInteger(source, "REDIS_STATE_TTL_SECONDS", 86_400),
    maxUpdateAttempts: readPositiveInteger(source, "REDIS_UPDATE_MAX_ATTEMPTS", 12),
    adapterKey: source.SOCKETIO_REDIS_KEY?.trim() || "dancesync",
  };
}

/** The URL without credentials, safe to log. */
export function describeRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "redis";
  }
}
