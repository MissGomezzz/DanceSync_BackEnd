import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { SongSelectionService } from "../../domain/services/SongSelectionService.js";
import { updateRoom } from "../roomUpdates.js";

export interface ChooseSongInput {
  roomCode: string;
  playerId: string;
  songId: string;
}

export class ChooseSong {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: ChooseSongInput): Promise<Room> {
    return updateRoom(this.rooms, input.roomCode, (room) =>
      SongSelectionService.choose(room, input.playerId, input.songId),
    );
  }
}
