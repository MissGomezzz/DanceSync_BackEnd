import type { Room } from "../domain/model/Room.js";
import type { RoomRepository } from "../domain/ports/RoomRepository.js";

/**
 * RoomRepository.update for mutations that always keep the room. The domain
 * decision runs inside `mutate`, on the latest stored state, never on a room the
 * use case read earlier. Values a use case needs besides the room (an outcome, a
 * "finished" flag) are captured from inside `mutate`, so they describe the state
 * that was actually stored.
 */
export async function updateRoom(rooms: RoomRepository, code: string, mutate: (room: Room) => Room): Promise<Room> {
  const updated = await rooms.update(code, mutate);
  // Unreachable: `mutate` cannot return null. Narrows the type for callers.
  if (!updated) throw new Error(`Room ${code} disappeared during an update that keeps it`);
  return updated;
}
