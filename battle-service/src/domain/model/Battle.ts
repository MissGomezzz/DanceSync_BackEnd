import type { Rating } from "./Rating.js";
import type { Song } from "./Song.js";

/** Time spectators keep to rate after the song ends, unless configured otherwise. */
export const DEFAULT_RATING_GRACE_MS = 30_000;

export interface BattleResult {
  /** Total per dancer: the spectators' ratings plus the word race bonus. */
  scores: Record<string, number>;
  /** Null on a draw — the real tie-break rule is a separate HU. */
  winnerId: string | null;
}

/** A dancer as they were when the battle started. */
export interface RosterEntry {
  id: string;
  displayName: string;
}

export interface Battle {
  id: string;
  roomCode: string;
  /** Dancers still competing; a dancer who leaves is dropped from this list. */
  dancerIds: string[];
  /**
   * Every dancer of the battle, snapshotted at the start and never shrunk, so the
   * names of dancers who left stay available (results, history, word race).
   */
  roster: RosterEntry[];
  /** Song picked in the lobby, or null when the battle started without one. */
  song: Song | null;
  ratings: Rating[];
  /**
   * Bonus points won per dancer by typing the word race words first. They are
   * added to the ratings when the battle finishes and are visible while it runs.
   */
  bonusPoints: Record<string, number>;
  /** When the dancing begins (the start command plus the countdown). */
  startedAt: Date;
  /**
   * When the battle finishes on its own if it is still running: the end of the
   * song clip plus the rating grace period. Without it a battle with no
   * spectators (or whose last spectator left) could never finish.
   */
  endsAt: Date;
  finishedAt: Date | null;
  result: BattleResult | null;
}