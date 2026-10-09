import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";
import { updateRoom } from "../roomUpdates.js";

export interface KickPlayerInput {
  roomCode: string;
  /** Player asking for the kick; must be the room host. */
  requesterId: string;
  /** Player to remove from the lobby. */
  playerId: string;
}

/**
 * The host removes a player from the lobby, e.g. someone idle who never marks
 * themselves ready and would otherwise keep the whole room from starting.
 */
export class KickPlayer {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: KickPlayerInput): Promise<Room> {
    const now = new Date();
    return updateRoom(this.rooms, input.roomCode, (room) => RoomService.kick(room, input.requesterId, input.playerId, now));
  }
}
