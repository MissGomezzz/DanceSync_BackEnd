import type { WordRace, WordRound } from "../model/WordRace.js";

export type ClaimRoundResult =
  | { claimed: true; round: WordRound }
  | { claimed: false; round: WordRound | null };

/**
 * Storage for the mid-battle word race.
 *
 * The state transitions of a round (open, claim, expire) are compare-and-set
 * operations: each one checks its precondition and applies the change as one
 * atomic step inside the store. Use cases must never decide a transition from a
 * value they read earlier, because with an async store (or several service
 * instances) that value can be stale by the time they write it back.
 */
export interface WordRaceRepository {
  /** Stores (or replaces) the whole race. Only used to create it. */
  save(race: WordRace): Promise<void>;
  find(roomCode: string): Promise<WordRace | undefined>;
  delete(roomCode: string): Promise<void>;

  /**
   * scheduled -> open. Returns the opened round, or null when the race or round
   * does not exist or the round was not scheduled.
   *
   * Redis: Lua script (or WATCH/MULTI) checking `status == scheduled` before setting it.
   * SQL: `UPDATE word_rounds SET status = 'open' WHERE id = $1 AND status = 'scheduled'`.
   */
  openRound(roomCode: string, roundId: string): Promise<WordRound | null>;

  /**
   * Atomic compare-and-set: succeeds only if the round is still open, not past
   * closesAt, and has no winner. On success the round becomes "won" by `playerId`
   * and that player's win count is incremented in the same step. Exactly one
   * caller can ever get `claimed: true` for a round.
   *
   * Redis: `SET word:{room}:{round}:winner <playerId> NX PX <ttl>` (OK means you won;
   * nil means someone else did), or a Lua script that also bumps the win count.
   * SQL: `UPDATE word_rounds SET winner_id = $1, status = 'won' WHERE id = $2
   * AND status = 'open' AND winner_id IS NULL AND closes_at > now()`;
   * rowCount === 1 means you won.
   */
  claimRound(roomCode: string, roundId: string, playerId: string, now: Date): Promise<ClaimRoundResult>;

  /**
   * open -> expired, only if nobody won and `now` is at or past closesAt (the
   * complement of the claim condition, so a claim and an expiry can never both
   * succeed). Returns the expired round, or null when there was nothing to expire.
   *
   * Redis: Lua script expiring only when the winner key does not exist.
   * SQL: `UPDATE word_rounds SET status = 'expired' WHERE id = $1 AND status = 'open'
   * AND winner_id IS NULL AND closes_at <= now()`.
   */
  expireRound(roomCode: string, roundId: string, now: Date): Promise<WordRound | null>;
}
