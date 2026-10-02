import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { SongSelectionService } from "../../domain/services/SongSelectionService.js";

export interface ChooseSongInput {
  roomCode: string;
  playerId: string;
  songId: string;
}

export class ChooseSong {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: ChooseSongInput): Promise<Room> {
    const room = await this.rooms.findByCode(input.roomCode);
    if (!room) throw new DomainError("ROOM_NOT_FOUND", `Room ${input.roomCode} does not exist`);
    const updated = SongSelectionService.choose(room, input.playerId, input.songId);
    await this.rooms.save(updated);
    return updated;
  }
}
