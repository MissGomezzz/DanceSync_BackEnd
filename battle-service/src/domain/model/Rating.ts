export const MIN_SCORE = 1;
export const MAX_SCORE = 5;

export interface Rating {
  raterId: string;
  dancerId: string;
  /** Integer between MIN_SCORE and MAX_SCORE inclusive. */
  score: number;
  submittedAt: Date;
}
