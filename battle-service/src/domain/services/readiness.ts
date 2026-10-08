import { DomainError } from "../errors/DomainError.js";
import type { Room } from "../model/Room.js";

/** Throws PLAYERS_NOT_READY, naming who is missing, unless every player in the room is ready. */
export function requireEveryoneReady(room: Room): void {
  const notReady = room.players.filter((p) => !p.ready);
  if (notReady.length > 0) {
    throw new DomainError(
      "PLAYERS_NOT_READY",
      `Every player must be ready to start; waiting for ${notReady.map((p) => p.displayName).join(", ")}`,
    );
  }
}
