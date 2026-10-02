import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService, validatePlayer } from "../../domain/services/RoomService.js";

export interface CreateRoomInput {
  hostId: string;
  displayName: string;
}

export class CreateRoom {
  constructor(private readonly rooms: RoomRepository) {}

  /** Throws INVALID_PLAYER when the host id or display name is not acceptable. */
  async execute(input: CreateRoomInput): Promise<Room> {
    const host = validatePlayer(input.hostId, input.displayName);
    // insert is atomic, so two rooms can never share a code; on the unlikely
    // collision a new code is generated.
    for (;;) {
      const room = RoomService.create(host);
      if (await this.rooms.insert(room)) return room;
    }
  }
}
