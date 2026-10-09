import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomMutation, RoomRepository } from "../../domain/ports/RoomRepository.js";

/**
 * Process-local store. Replace with Redis or a database when scaling beyond one
 * instance (see RoomRepository.update for how the port maps to them).
 *
 * `update` reads, runs the mutation, checks the version and writes inside ONE
 * synchronous block (no `await` in between). Node runs that block to completion
 * before any other callback, so concurrent updates are serialized and each one
 * decides on the state left by the previous one: the in-memory equivalent of
 * the conditional UPDATE in SQL or WATCH/MULTI in Redis, without retries since
 * a conflict cannot happen. Rooms are stored and returned as copies so callers
 * can never change the stored state behind the store's back.
 */
export class InMemoryRoomRepository implements RoomRepository {
  private readonly rooms = new Map<string, Room>();

  async findByCode(code: string): Promise<Room | undefined> {
    const room = this.rooms.get(key(code));
    return room ? structuredClone(room) : undefined;
  }

  async listCodes(): Promise<string[]> {
    return [...this.rooms.values()].map((room) => room.code);
  }

  async insert(room: Room): Promise<boolean> {
    if (this.rooms.has(key(room.code))) return false;
    this.rooms.set(key(room.code), structuredClone(room));
    return true;
  }

  async update(code: string, mutate: RoomMutation): Promise<Room | null> {
    // --- critical section (synchronous) ---
    const current = this.rooms.get(key(code));
    if (!current) throw new DomainError("ROOM_NOT_FOUND", `Room ${code} does not exist`);
    const draft = structuredClone(current);
    const next = mutate(draft);
    if (next === draft) return draft; // No change, no write.
    // Version check: the new state must derive from the state just read. A
    // mutation returning a room it obtained earlier (the read -> save pattern this
    // port exists to prevent) carries an older version and is refused.
    if (next !== null && next.version !== current.version) {
      throw new Error(
        `Stale write to room ${code}: based on version ${next.version}, stored version is ${current.version}`,
      );
    }
    if (next === null) {
      this.rooms.delete(key(code));
      return null;
    }
    const stored: Room = { ...next, version: current.version + 1 };
    this.rooms.set(key(code), structuredClone(stored));
    return stored;
  }
}

function key(code: string): string {
  return code.toUpperCase();
}
