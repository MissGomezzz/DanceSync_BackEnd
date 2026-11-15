import type { Redis } from "ioredis";
import { SESSION_WINDOW_MS, type SessionTracker } from "../../application/ports/SessionTracker.js";

export interface RedisSessionTrackerOptions {
  windowMs?: number;
  /** Key prefix; tests use their own. Default "session:". */
  prefix?: string;
}

/**
 * SessionTracker shared by every replica (OBS-1): `SET session:<user> NX PX
 * <window>` succeeds only for the first handshake in the window, whichever
 * replica serves it, so the session is counted once. A later handshake renews
 * the window (PEXPIRE), so a user who keeps reconnecting stays in one session.
 */
export class RedisSessionTracker implements SessionTracker {
  private readonly windowMs: number;
  private readonly prefix: string;

  constructor(
    private readonly redis: Redis,
    options: RedisSessionTrackerOptions = {},
  ) {
    this.windowMs = options.windowMs ?? SESSION_WINDOW_MS;
    this.prefix = options.prefix ?? "session:";
  }

  async touch(userId: string): Promise<boolean> {
    const key = `${this.prefix}${userId}`;
    const created = await this.redis.set(key, "1", "PX", this.windowMs, "NX");
    if (created === "OK") return true;
    await this.redis.pexpire(key, this.windowMs);
    return false;
  }
}
