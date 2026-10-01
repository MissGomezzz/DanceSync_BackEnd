import type { Rating } from "./Rating.js";

export interface BattleResult {
  scores: Record<string, number>;
  /** Null on a draw — the real tie-break rule (bonuses mid-song) is a separate HU. */
  winnerId: string | null;
}

export interface Battle {
  id: string;
  roomCode: string;
  dancerIds: string[];
  ratings: Rating[];
  startedAt: Date;
  finishedAt: Date | null;
  result: BattleResult | null;
}