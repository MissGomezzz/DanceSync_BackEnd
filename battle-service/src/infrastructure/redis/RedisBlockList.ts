import type { Redis } from "ioredis";
import type { BlockList } from "../abuse/blockList.js";

/** BlockList on Redis: one key per blocked identity or address, expiring by itself. */
export class RedisBlockList implements BlockList {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "abuse:block:",
  ) {}

  async block(keys: string[], ttlMs: number): Promise<void> {
    if (keys.length === 0) return;
    const ttl = Math.max(1, Math.ceil(ttlMs));
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.set(this.prefix + key, "1", "PX", ttl);
    for (const [error] of (await pipeline.exec()) ?? []) if (error) throw error;
  }

  async remainingMs(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.pttl(this.prefix + key);
    let remaining = 0;
    for (const [error, ttl] of (await pipeline.exec()) ?? []) {
      if (error) throw error;
      remaining = Math.max(remaining, Number(ttl)); // -2: no key, -1: no expiry (never written that way)
    }
    return remaining;
  }
}
