export type DomainErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "ROOM_NOT_WAITING"
  | "ROOM_NOT_BATTLING"
  | "PLAYER_ALREADY_IN_ROOM"
  | "PLAYER_NOT_IN_ROOM"
  | "NOT_ENOUGH_PLAYERS"
  | "INVALID_DANCER"
  | "INVALID_RATER"
  | "INVALID_SCORE"
  | "DUPLICATE_RATING"
  | "INVALID_MESSAGE";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
