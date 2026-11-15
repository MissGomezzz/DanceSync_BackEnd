import type { Clock } from "./TokenBucket.js";

/**
 * Temporary blocks of abusive clients (SEG-3). A key names who is blocked
 * (`player:<id>` or `ip:<address>`). With Redis the blocks are shared, so a
 * client blocked by one replica is refused by every other one.
 */
export interface BlockList {
  /** Blocks every key for `ttlMs`. */
  block(keys: string[], ttlMs: number): Promise<void>;
  /** The longest remaining block among the keys, in ms; 0 when none is blocked. */
  remainingMs(keys: string[]): Promise<number>;
}

export class InMemoryBlockList implements BlockList {
  private readonly until = new Map<string, number>();

  constructor(private readonly now: Clock = Date.now) {}

  async block(keys: string[], ttlMs: number): Promise<void> {
    const until = this.now() + ttlMs;
    for (const key of keys) this.until.set(key, Math.max(until, this.until.get(key) ?? 0));
  }

  async remainingMs(keys: string[]): Promise<number> {
    const at = this.now();
    let remaining = 0;
    for (const key of keys) {
      const until = this.until.get(key);
      if (until === undefined) continue;
      if (until <= at) this.until.delete(key);
      else remaining = Math.max(remaining, until - at);
    }
    return remaining;
  }
}
