import type { MatchRecord } from "../../domain/model/MatchRecord.js";
import type { MatchOutbox, PendingMatch } from "../../domain/ports/MatchOutbox.js";

const DEFAULT_DELIVERED_RETENTION_MS = 2 * 86_400_000;

/**
 * Process-local outbox: survives an unavailable users-service, not the death
 * of the process (that takes the Redis one, shared by every replica). Each
 * method runs without an await, so it is atomic for this process.
 */
export class InMemoryMatchOutbox implements MatchOutbox {
  private readonly pending = new Map<string, PendingMatch>();
  /** Delivered match id -> when (epoch ms), kept for deliveredRetentionMs. */
  private readonly delivered = new Map<string, number>();

  constructor(
    private readonly deliveredRetentionMs: number = DEFAULT_DELIVERED_RETENTION_MS,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async enqueue(match: MatchRecord, notBefore: Date): Promise<boolean> {
    if (this.pending.has(match.id) || this.delivered.has(match.id)) return false;
    this.pending.set(match.id, structuredClone({ match, attempts: 0, nextAttemptAt: notBefore }));
    return true;
  }

  async listPending(now: Date, limit: number): Promise<PendingMatch[]> {
    return [...this.pending.values()]
      .filter((p) => p.nextAttemptAt.getTime() <= now.getTime())
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit)
      .map((p) => structuredClone(p));
  }

  async ack(matchId: string): Promise<void> {
    const now = this.clock().getTime();
    this.pending.delete(matchId);
    this.delivered.set(matchId, now);
    for (const [id, at] of this.delivered) if (now - at > this.deliveredRetentionMs) this.delivered.delete(id);
  }

  async retryLater(pending: PendingMatch): Promise<void> {
    if (!this.pending.has(pending.match.id)) return;
    this.pending.set(pending.match.id, structuredClone(pending));
  }
}
