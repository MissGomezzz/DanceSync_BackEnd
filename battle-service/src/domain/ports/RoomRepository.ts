import type { Room } from "../model/Room.js";

/**
 * Decides the next state of a room from its latest stored state. Must be pure
 * and synchronous: the store may call it more than once (see `update`).
 * - returns a new Room: that state is stored (with the version bumped);
 * - returns the very room it received: nothing changed, nothing is written;
 * - returns null: the room is deleted;
 * - throws (typically a DomainError): nothing is written and the error propagates.
 */
export type RoomMutation = (room: Room) => Room | null;

/**
 * Storage for the Room aggregate, with optimistic concurrency control.
 *
 * Several commands can target the same room at once (two spectators rating, a
 * role change racing the battle start, a timer firing while a player leaves).
 * Socket.IO even dispatches the frames of one socket through process.nextTick,
 * so two events read in the same TCP chunk run interleaved: with a plain
 * read -> decide -> save, both handlers read version N, both save, and the
 * second save silently drops the first change (lost update).
 *
 * Every change therefore goes through `update`, which re-runs the domain
 * decision on the latest state and only writes if nobody wrote in between.
 * There is deliberately no blind `save(room)`.
 */
export interface RoomRepository {
  findByCode(code: string): Promise<Room | undefined>;

  /**
   * Codes of every stored room, for housekeeping (releasing abandoned seats,
   * deleting empty rooms). SQL: `SELECT code FROM rooms`; Redis: `SCAN` on room:*.
   */
  listCodes(): Promise<string[]>;

  /**
   * Stores a brand-new room. Returns false, writing nothing, when the code is
   * already taken.
   *
   * SQL: `INSERT INTO rooms (code, data, version) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`
   * (rowCount 1 = stored). Redis: `SET room:{code} <json> NX`.
   */
  insert(room: Room): Promise<boolean>;

  /**
   * Atomically applies `mutate` to the current state of the room and returns
   * the stored result (null when the mutation deleted the room). Throws
   * DomainError ROOM_NOT_FOUND when the room does not exist, and lets any
   * error thrown by `mutate` propagate unchanged. The stored version grows by
   * one on every write, so a reader can tell which of two states is newer.
   *
   * A real store maps it to a compare-and-set on the version, retried a bounded
   * number of times (e.g. 5) with a short jittered backoff:
   * - SQL: `SELECT data, version FROM rooms WHERE code = $1`, run `mutate`, then
   *   `UPDATE rooms SET data = $1, version = version + 1 WHERE code = $2 AND version = $3`
   *   (or `DELETE ... WHERE code = $1 AND version = $2`). rowCount 0 means
   *   another writer got there first: re-read and run `mutate` again on the new state.
   * - Redis: `WATCH room:{code}`, `GET`, run `mutate`, `MULTI` / `SET` / `EXEC`;
   *   a nil EXEC reply is the conflict, retried the same way.
   * When the retries run out the command fails instead of overwriting.
   */
  update(code: string, mutate: RoomMutation): Promise<Room | null>;
}
