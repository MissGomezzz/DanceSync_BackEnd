import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";

/** Process-local store. Replace with Redis or a database when scaling beyond one instance. */
export class InMemoryRoomRepository implements RoomRepository {
  private readonly rooms = new Map<string, Room>();

  async findByCode(code: string): Promise<Room | undefined> {
    return this.rooms.get(code.toUpperCase());
  }

  async save(room: Room): Promise<void> {
    this.rooms.set(room.code.toUpperCase(), room);
  }

  async delete(code: string): Promise<void> {
    this.rooms.delete(code.toUpperCase());
  }
}
