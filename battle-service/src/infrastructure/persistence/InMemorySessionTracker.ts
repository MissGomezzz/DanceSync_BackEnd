import { SESSION_WINDOW_MS, type SessionTracker } from "../../application/ports/SessionTracker.js";

/** Process-local SessionTracker (one instance, no REDIS_URL). Each handshake renews the window. */
export class InMemorySessionTracker implements SessionTracker {
  /** userId -> last handshake (epoch ms). */
  private readonly lastSeen = new Map<string, number>();

  constructor(
    private readonly windowMs: number = SESSION_WINDOW_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  async touch(userId: string): Promise<boolean> {
    const now = this.clock();
    const previous = this.lastSeen.get(userId);
    this.lastSeen.set(userId, now);
    if (this.lastSeen.size > 1_000) this.prune(now);
    return previous === undefined || now - previous >= this.windowMs;
  }

  private prune(now: number): void {
    for (const [userId, seenAt] of this.lastSeen) if (now - seenAt >= this.windowMs) this.lastSeen.delete(userId);
  }
}
