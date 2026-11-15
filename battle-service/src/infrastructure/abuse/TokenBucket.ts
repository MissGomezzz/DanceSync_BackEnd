/**
 * Token bucket (SEG-3): `capacity` tokens at most, refilled continuously at
 * `ratePerSecond`. Each event takes one token; without a token the event is
 * refused. A full bucket absorbs a legitimate burst (for example, several
 * events when a word round opens), while a sustained flood above the rate runs
 * it dry within a fraction of a second.
 *
 * The clock is injected so tests can move time without waiting.
 */
export type Clock = () => number;

export interface TakeResult {
  allowed: boolean;
  /** Milliseconds until the next token is available (0 when allowed). */
  retryAfterMs: number;
}

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly capacity: number,
    private readonly now: Clock = Date.now,
  ) {
    if (!(ratePerSecond > 0)) throw new Error("ratePerSecond must be greater than 0");
    if (!(capacity >= 1)) throw new Error("capacity must be at least 1");
    this.tokens = capacity;
    this.updatedAt = now();
  }

  take(): TakeResult {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000) };
  }

  /** Tokens available right now (for tests and diagnostics). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const at = this.now();
    const elapsedMs = Math.max(0, at - this.updatedAt);
    this.updatedAt = at;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.ratePerSecond);
  }
}
