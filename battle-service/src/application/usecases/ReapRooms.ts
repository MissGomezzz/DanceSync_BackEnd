import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";

/**
 * Housekeeping for rooms nobody is using any more. Which seats are abandoned
 * depends on the live connections, so that decision belongs to the transport
 * layer; this use case only reads the rooms and removes the ones left empty.
 * Seats themselves are released through the normal leave path (JoinRoom.leave).
 */
export class ReapRooms {
  constructor(private readonly rooms: RoomRepository) {}

  /** Every stored room, read one by one (a room deleted meanwhile is skipped). */
  async list(): Promise<Room[]> {
    const found: Room[] = [];
    for (const code of await this.rooms.listCodes()) {
      const room = await this.rooms.findByCode(code);
      if (room) found.push(room);
    }
    return found;
  }

  /** Deletes the room when it has no players left. Returns true when it was deleted. */
  async deleteIfEmpty(code: string): Promise<boolean> {
    try {
      const result = await this.rooms.update(code, (room) => (room.players.length === 0 ? null : room));
      return result === null;
    } catch (error) {
      if (error instanceof DomainError && error.code === "ROOM_NOT_FOUND") return false;
      throw error;
    }
  }
}
