import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService, requireRoomCode, validatePlayer } from "../../domain/services/RoomService.js";
import { updateRoom } from "../roomUpdates.js";

export interface JoinRoomInput {
  roomCode: string;
  playerId: string;
  displayName: string;
}

export interface LeaveRoomInput {
  roomCode: string;
  playerId: string;
}

export interface LeaveRoomOutput {
  /** The updated room, or null when the last player left and the room was removed. */
  room: Room | null;
  /**
   * True when this departure finished the running battle (too few dancers are
   * left). The caller must announce it and stop the word race.
   */
  battleFinished: boolean;
  /**
   * Spectators still in the room whose vote was discarded because the dancer
   * they voted for left; they can vote again and must be told (vote:mine).
   */
  discardedVoterIds: string[];
}

export class JoinRoom {
  constructor(private readonly rooms: RoomRepository) {}

  /** The payload comes straight from a client: every field is validated before use. */
  async execute(input: JoinRoomInput): Promise<Room> {
    const roomCode = requireRoomCode(input.roomCode);
    const player = validatePlayer(input.playerId, input.displayName);
    return updateRoom(this.rooms, roomCode, (room) =>
      // Idempotent rejoin: the host is added when the room is created and clients
      // re-emit room:join after a page refresh. Returning the room unchanged lets
      // the socket handler still join the channel and broadcast the current state,
      // while RoomService.join stays a strict domain rule.
      room.players.some((p) => p.id === player.id) ? room : RoomService.join(room, player),
    );
  }

  async leave(input: LeaveRoomInput): Promise<LeaveRoomOutput> {
    let battleFinished = false;
    let discardedVoterIds: string[] = [];
    // Removing the last player deletes the room in the same atomic step, so a
    // player joining at that moment either gets in first (and keeps the room
    // alive) or finds it gone, never a seat in a room deleted right after.
    const now = new Date();
    const room = await this.rooms.update(input.roomCode, (current) => {
      const updated = RoomService.leave(current, input.playerId, now);
      battleFinished = current.status === "battling" && updated.status === "finished";
      const votesLeft = updated.battle?.votes ?? {};
      discardedVoterIds = Object.keys(current.battle?.votes ?? {}).filter(
        (voterId) => voterId !== input.playerId && !(voterId in votesLeft),
      );
      return updated.players.length === 0 ? null : updated;
    });
    return { room, battleFinished, discardedVoterIds };
  }
}
