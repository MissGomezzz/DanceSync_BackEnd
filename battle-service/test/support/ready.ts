import type { Socket as ClientSocket } from "socket.io-client";
import { SONG_CATALOG } from "../../src/domain/catalog/songs.js";
import type { Room } from "../../src/domain/model/Room.js";
import type { RoomRepository } from "../../src/domain/ports/RoomRepository.js";
import { RoomService } from "../../src/domain/services/RoomService.js";
import { ok } from "./socketHarness.js";

/** Marks every player of the room as ready, the first precondition to start a battle. */
export function allReady(room: Room): Room {
  return room.players.reduce((current, p) => RoomService.setReady(current, p.id, true), room);
}

/** Everything a battle needs to start: every player ready and a song chosen. */
export function startable(room: Room): Room {
  return { ...allReady(room), selectedSong: SONG_CATALOG[0] };
}

/** Each socket marks its own player as ready, as the lobby's ready button does. */
export async function readyUp(roomCode: string, players: Record<string, ClientSocket>): Promise<void> {
  for (const [playerId, socket] of Object.entries(players)) {
    await ok(socket, "player:ready", { roomCode, playerId, ready: true });
  }
}

/** Stores a chosen song without running the typing challenge, for tests about what happens after it. */
export async function pickSong(rooms: RoomRepository, roomCode: string): Promise<void> {
  await rooms.update(roomCode, (room) => ({ ...room, selectedSong: SONG_CATALOG[0] }));
}
