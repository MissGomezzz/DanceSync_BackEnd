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
    // insert is atomic, so two rooms can never share a code; on the unlikely
    // collision a new code is generated.
    for (;;) {
      const room = RoomService.create({ id: input.hostId, displayName: input.displayName });
      if (await this.rooms.insert(room)) return room;
    }
  }
}
