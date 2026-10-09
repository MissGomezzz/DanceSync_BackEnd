export type DomainErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "ROOM_NOT_WAITING"
  | "ROOM_NOT_BATTLING"
  | "PLAYER_ALREADY_IN_ROOM"
  | "PLAYER_NOT_IN_ROOM"
  | "INVALID_PLAYER"
  | "NOT_ENOUGH_PLAYERS"
  | "NOT_ENOUGH_DANCERS"
  | "INVALID_DANCER"
  | "PLAYERS_NOT_READY"
  | "SONG_NOT_SELECTED"
  | "INVALID_RATER"
  | "NOT_HOST"
  | "INVALID_SCORE"
  | "DUPLICATE_RATING"
  | "INVALID_MESSAGE"
  | "SONG_SELECTION_IN_PROGRESS"
  | "SONG_SELECTION_NOT_ACTIVE"
  | "NOT_CHALLENGE_PARTICIPANT"
  | "ATTEMPT_ALREADY_USED"
  | "NOT_SONG_CHOOSER"
  | "INVALID_SONG"
  | "WORD_RACE_NOT_ACTIVE"
  | "WORD_ROUND_NOT_OPEN";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
