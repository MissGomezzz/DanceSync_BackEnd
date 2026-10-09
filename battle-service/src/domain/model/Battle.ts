import type { Song } from "./Song.js";

/** Points a spectator's vote is worth, unless configured otherwise (VOTE_POINTS). */
export const DEFAULT_VOTE_POINTS = 2;
/** Points a word race round won is worth, unless configured otherwise (WORD_BONUS_POINTS). */
export const DEFAULT_WORD_BONUS_POINTS = 1;

/** How much each source of points is worth; snapshotted when the battle starts. */
export interface ScoringPoints {
  votePoints: number;
  wordBonusPoints: number;
}

/**
 * - song-end: the song clip ended (battle.endsAt).
 * - not-enough-dancers: dancers left until fewer than MIN_DANCERS_PER_BATTLE remained.
 */
export type BattleEndReason = "song-end" | "not-enough-dancers";

/** One dancer's line in the ranking, live during the battle and frozen in the result. */
export interface Standing {
  dancerId: string;
  displayName: string;
  /** Spectators currently voting for this dancer. */
  votes: number;
  /** Word race rounds this dancer typed first. */
  wordsWon: number;
  /** votePoints x votes + wordBonusPoints x wordsWon. */
  score: number;
  /** Competition ranking: equal scores share a rank (1, 1, 3). */
  rank: number;
}

export interface BattleResult {
  /** Dancers still in the battle when it finished, sorted by rank. */
  standings: Standing[];
  /** The only dancer ranked first; null on a draw at the top (or with no dancer left). */
  winnerId: string | null;
}

/** A player as they were when the battle started. */
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
  /** Every spectator when the battle started, never shrunk (match history, left-early flags). */
  audience: RosterEntry[];
  /** Song picked in the lobby, or null when the battle started without one. */
  song: Song | null;
  /**
   * Current vote of each spectator: voterId -> dancerId. At most one per
   * spectator; changed or withdrawn until the song ends. Private: only the totals
   * leave the server (see the room DTO), never who voted for whom.
   */
  votes: Record<string, string>;
  /** Word race rounds won per dancer (counts, not points). */
  wordsWon: Record<string, number>;
  /** Points per vote and per word won, fixed for the whole battle. */
  scoring: ScoringPoints;
  /** When the dancing begins (the start command plus the countdown). */
  startedAt: Date;
  /** When the song clip ends: the battle finishes then if it is still running. */
  endsAt: Date;
  finishedAt: Date | null;
  endReason: BattleEndReason | null;
  /** Set when the battle finishes; null while it runs. */
  result: BattleResult | null;
}
