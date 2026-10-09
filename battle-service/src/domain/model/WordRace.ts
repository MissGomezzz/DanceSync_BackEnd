/** Bonus points a dancer earns for winning a word round, unless configured otherwise. */
export const DEFAULT_WORD_BONUS_POINTS = 1;
/** Rounds per battle when nothing else is configured. */
export const DEFAULT_WORD_RACE_ROUNDS = 3;
/** Time dancers have to type each word. */
export const DEFAULT_WORD_WINDOW_MS = 10_000;
/** Minimum time between two round openings. */
export const DEFAULT_WORD_MIN_GAP_MS = 12_000;
/** Song length assumed when the battle started without a song. */
export const DEFAULT_WORD_FALLBACK_DURATION_MS = 90_000;
/** Rounds open inside this slice of the song, leaving the intro and the outro alone. */
export const DEFAULT_WORD_START_MARGIN_RATIO = 0.1;
export const DEFAULT_WORD_END_MARGIN_RATIO = 0.85;

/**
 * - scheduled: planned, not visible yet.
 * - open: the word is on screen and dancers race to type it.
 * - won: a dancer typed it first (winnerId is set).
 * - expired: the window closed and nobody typed it.
 */
export type WordRoundStatus = "scheduled" | "open" | "won" | "expired";

export interface WordRound {
  id: string;
  /** 1-based position inside the race. */
  number: number;
  word: string;
  opensAt: Date;
  closesAt: Date;
  winnerId: string | null;
  status: WordRoundStatus;
}

/**
 * Mid-battle word race. Kept as its own aggregate, outside Room, so ratings saved
 * concurrently on the Room can never overwrite who won a round (and vice versa).
 */
export interface WordRace {
  roomCode: string;
  battleId: string;
  /** Dancers snapshotted when the battle started; only they can type. */
  participantIds: string[];
  /** Display names snapshotted with the participants, so a winner who left can still be named. */
  participantNames: Record<string, string>;
  rounds: WordRound[];
  /** Rounds won per participant. The bonus itself is stored in Battle.bonusPoints. */
  wins: Record<string, number>;
}

/**
 * - won: this submission was the first correct one.
 * - late: typed correctly, but another dancer had already won the round.
 * - incorrect: the text does not match; the dancer may try again.
 * - expired: sent after the window closed.
 */
export type SubmitWordOutcome = "won" | "late" | "incorrect" | "expired";
