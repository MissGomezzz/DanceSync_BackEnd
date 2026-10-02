import type { Player } from "../../domain/model/Player.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";
import { updateRoom } from "../roomUpdates.js";

export interface SelectRoleInput {
  roomCode: string;
  playerId: string;
  role: Exclude<Player["role"], "undecided">;
}

export class SelectRole {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: SelectRoleInput): Promise<Room> {
    return updateRoom(this.rooms, input.roomCode, (room) => RoomService.selectRole(room, input.playerId, input.role));
  }
}
