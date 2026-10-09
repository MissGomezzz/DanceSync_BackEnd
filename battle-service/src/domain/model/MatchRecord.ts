import type { BattleEndReason } from "./Battle.js";

/** A player of a finished battle as stored in the match history (HU 21). */
export interface MatchParticipantRecord {
  playerId: string;
  displayName: string;
  role: "dancer" | "spectator";
  /**
   * Final statistics of a dancer ranked in the result. Null for spectators and
   * for dancers who left before the end (they are not ranked); a departed
   * dancer keeps the word rounds they had won.
   */
  votes: number | null;
  wordsWon: number | null;
  score: number | null;
  rank: number | null;
  /** True when the player left the room before the battle finished. */
  leftEarly: boolean;
}

/**
 * The document battle-service sends to users-service when a battle finishes.
 * Its id is the battle id, so storing it again (a retry) replaces it instead of
 * creating a second match.
 */
export interface MatchRecord {
  id: string;
  roomCode: string;
  songId: string | null;
  songTitle: string | null;
  startedAt: Date;
  finishedAt: Date;
  /** Null on a draw at the top. */
  winnerPlayerId: string | null;
  endReason: BattleEndReason;
  participants: MatchParticipantRecord[];
}
