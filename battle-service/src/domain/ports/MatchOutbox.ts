import type { MatchRecord } from "../model/MatchRecord.js";

/** A finished match waiting to reach the match history. */
export interface PendingMatch {
  match: MatchRecord;
  /** Delivery attempts made from the outbox so far (the finisher's immediate tries excluded). */
  attempts: number;
  /** Not to be tried again before this instant (backoff). */
  nextAttemptAt: Date;
}

/**
 * Durable outbox of finished matches (DIS-1, transactional outbox pattern).
 *
 * The replica that finishes a battle enqueues its result and tries to deliver
 * it at once; every replica's periodic sweep delivers what is still pending,
 * so a result survives the death of the replica that produced it and an outage
 * of users-service. An entry leaves the outbox only after a successful
 * delivery. Delivering twice is harmless: the match history stores matches
 * with an idempotent upsert keyed by the battle id.
 *
 * Every method is idempotent on the match id. Implementations: in memory (one
 * instance) and Redis (shared by every replica).
 */
export interface MatchOutbox {
  /**
   * Adds the match unless it is already pending or was delivered recently.
   * Returns true when it was added.
   */
  enqueue(match: MatchRecord, notBefore: Date): Promise<boolean>;
  /** Pending matches due at `now` (nextAttemptAt <= now), the most overdue first, at most `limit`. */
  listPending(now: Date, limit: number): Promise<PendingMatch[]>;
  /** The match was delivered: removes it and remembers it as delivered, so enqueue ignores it. */
  ack(matchId: string): Promise<void>;
  /** A delivery failed: the match stays for another try at nextAttemptAt. No-op if it was acked meanwhile. */
  retryLater(pending: PendingMatch): Promise<void>;
  /** Matches still pending, due or not (OBS-1 gauge). Optional for older implementations. */
  count?(): Promise<number>;
}
