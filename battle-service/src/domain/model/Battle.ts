import type { Rating } from "./Rating.js";
import type { Song } from "./Song.js";

export interface BattleResult {
  /** Total per dancer: the spectators' ratings plus the word race bonus. */
  scores: Record<string, number>;
  /** Null on a draw — the real tie-break rule is a separate HU. */
  winnerId: string | null;
}

export interface Battle {
  id: string;
  roomCode: string;
  dancerIds: string[];
  /** Song picked in the lobby, or null when the battle started without one. */
  song: Song | null;
  ratings: Rating[];
  /**
   * Bonus points won per dancer by typing the word race words first. They are
   * added to the ratings when the battle finishes and are visible while it runs.
   */
  bonusPoints: Record<string, number>;
  startedAt: Date;
  finishedAt: Date | null;
  result: BattleResult | null;
}