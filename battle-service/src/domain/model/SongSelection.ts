import type { Song } from "./Song.js";

/** Default time players have to type the phrase. */
export const DEFAULT_SONG_CHALLENGE_MS = 15_000;

/**
 * - typing: the phrase is on screen and participants race to type it.
 * - choosing: a chooser won (or was assigned) the privilege and must pick a song.
 * - done: the song was chosen and stored in Room.selectedSong.
 */
export type SongSelectionPhase = "typing" | "choosing" | "done";

/**
 * How the chooser got the privilege:
 * - typed: first participant to submit the exact phrase.
 * - timeout: nobody typed it in time, the predefined fallback picked someone.
 * - all-failed: every participant misspelled it, the fallback picked someone.
 * - chooser-left: the previous chooser left before picking, the turn was passed on.
 */
export type ChooserReason = "typed" | "timeout" | "all-failed" | "chooser-left";

export interface SongChallenge {
  id: string;
  phrase: string;
  startedAt: Date;
  expiresAt: Date;
}

export interface SongSelection {
  phase: SongSelectionPhase;
  challenge: SongChallenge;
  /** Players allowed to type, snapshotted when the challenge starts. */
  participantIds: string[];
  /** Participants whose submission was rejected; they lose this round's chance. */
  failedIds: string[];
  chooserId: string | null;
  chooserReason: ChooserReason | null;
  songOptions: Song[];
}
