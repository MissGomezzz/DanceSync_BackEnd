import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";

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
    const room = await this.requireRoom(input.roomCode);
    // Idempotent rejoin: the host is added when the room is created and clients
    // re-emit room:join after a page refresh. Returning the room unchanged lets
    // the socket handler still join the channel and broadcast the current state,
    // while RoomService.join stays a strict domain rule.
    if (room.players.some((p) => p.id === input.playerId)) {
      return room;
    }
    const updated = RoomService.join(room, { id: input.playerId, displayName: input.displayName });
    await this.rooms.save(updated);
    return updated;
  }

  async leave(input: LeaveRoomInput): Promise<LeaveRoomOutput> {
    const room = await this.requireRoom(input.roomCode);
    const updated = RoomService.leave(room, input.playerId);
    const battleFinished = room.status === "battling" && updated.status === "finished";
    if (updated.players.length === 0) {
      await this.rooms.delete(room.code);
      return { room: null, battleFinished };
    }
    await this.rooms.save(updated);
    return { room: updated, battleFinished };
  }

  private async requireRoom(code: string): Promise<Room> {
    const room = await this.rooms.findByCode(code);
    if (!room) throw new DomainError("ROOM_NOT_FOUND", `Room ${code} does not exist`);
    return room;
  }
}
