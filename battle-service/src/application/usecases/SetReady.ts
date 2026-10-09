import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";
import { updateRoom } from "../roomUpdates.js";

export interface SetReadyInput {
  roomCode: string;
  playerId: string;
  ready: boolean;
}

export class SetReady {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: SetReadyInput): Promise<Room> {
    return updateRoom(this.rooms, input.roomCode, (room) => RoomService.setReady(room, input.playerId, input.ready));
  }
}
