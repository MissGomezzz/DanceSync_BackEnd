import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";
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
   * True when this departure finished the running battle: too few dancers are left
   * (result null) or every remaining spectator had already rated every remaining
   * dancer (result available). The caller must announce it and stop the word race.
   */
  battleFinished: boolean;
}

export class JoinRoom {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: JoinRoomInput): Promise<Room> {
    return updateRoom(this.rooms, input.roomCode, (room) =>
      // Idempotent rejoin: the host is added when the room is created and clients
      // re-emit room:join after a page refresh. Returning the room unchanged lets
      // the socket handler still join the channel and broadcast the current state,
      // while RoomService.join stays a strict domain rule.
      room.players.some((p) => p.id === input.playerId)
        ? room
        : RoomService.join(room, { id: input.playerId, displayName: input.displayName }),
    );
  }

  async leave(input: LeaveRoomInput): Promise<LeaveRoomOutput> {
    let battleFinished = false;
    // Removing the last player deletes the room in the same atomic step, so a
    // player joining at that moment either gets in first (and keeps the room
    // alive) or finds it gone, never a seat in a room deleted right after.
    const room = await this.rooms.update(input.roomCode, (current) => {
      const updated = RoomService.leave(current, input.playerId);
      battleFinished = current.status === "battling" && updated.status === "finished";
      return updated.players.length === 0 ? null : updated;
    });
    return { room, battleFinished };
  }
}
