import assert from "node:assert/strict";
import { DomainError } from "../../src/domain/errors/DomainError.js";
import type { Room } from "../../src/domain/model/Room.js";
import { RoomService, type StartBattleOptions } from "../../src/domain/services/RoomService.js";
import { startable } from "./ready.js";

export const T0 = new Date("2026-01-01T00:00:00Z");

/** T0 plus `ms`. */
export function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

/**
 * Running battle in room ROOM01 (domain only): the first dancer is the host,
 * every player's display name is their id in upper case.
 */
export function battleRoom(dancers: string[], spectators: string[], options: StartBattleOptions = {}): Room {
  const [hostId, ...others] = [...dancers, ...spectators];
  let room = RoomService.create({ id: hostId, displayName: hostId.toUpperCase() }, "ROOM01");
  for (const id of others) room = RoomService.join(room, { id, displayName: id.toUpperCase() });
  for (const id of dancers) room = RoomService.selectRole(room, id, "dancer");
  for (const id of spectators) room = RoomService.selectRole(room, id, "spectator");
  return RoomService.startBattle(startable(room), undefined, { now: T0, ...options });
}

export function assertDomainError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code, `expected ${code}`);
}
