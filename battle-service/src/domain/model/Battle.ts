import type { Rating } from "./Rating.js";

export interface BattleResult {
  scores: Record<string, number>;
  /** Null on a draw. */
  winnerId: string | null;
}

export interface Battle {
  id: string;
  roomCode: string;
  dancerIds: [string, string];
  ratings: Rating[];
  startedAt: Date;
  finishedAt: Date | null;
  result: BattleResult | null;
}
