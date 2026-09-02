import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";

export interface CreateRoomInput {
  hostId: string;
  displayName: string;
}

export class CreateRoom {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: CreateRoomInput): Promise<Room> {
    let room = RoomService.create({ id: input.hostId, displayName: input.displayName });
    // Regenerate on the unlikely code collision.
    while (await this.rooms.findByCode(room.code)) {
      room = RoomService.create({ id: input.hostId, displayName: input.displayName });
    }
    await this.rooms.save(room);
    return room;
  }
}
