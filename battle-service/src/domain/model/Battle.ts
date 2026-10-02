import type { Rating } from "./Rating.js";
import type { Song } from "./Song.js";

export interface BattleResult {
  scores: Record<string, number>;
  /** Null on a draw — the real tie-break rule (bonuses mid-song) is a separate HU. */
  winnerId: string | null;
}

export interface Battle {
  id: string;
  roomCode: string;
  dancerIds: string[];
  /** Song picked in the lobby, or null when the battle started without one. */
  song: Song | null;
  ratings: Rating[];
  startedAt: Date;
  finishedAt: Date | null;
  result: BattleResult | null;
}