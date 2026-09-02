import type { Room } from "../model/Room.js";

export interface RoomRepository {
  findByCode(code: string): Promise<Room | undefined>;
  save(room: Room): Promise<void>;
  delete(code: string): Promise<void>;
}
