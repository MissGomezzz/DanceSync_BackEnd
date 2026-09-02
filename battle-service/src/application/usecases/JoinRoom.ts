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

export class JoinRoom {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: JoinRoomInput): Promise<Room> {
    const room = await this.requireRoom(input.roomCode);
    const updated = RoomService.join(room, { id: input.playerId, displayName: input.displayName });
    await this.rooms.save(updated);
    return updated;
  }

  /** Returns the updated room, or null when the last player left and the room was removed. */
  async leave(input: LeaveRoomInput): Promise<Room | null> {
    const room = await this.requireRoom(input.roomCode);
    const updated = RoomService.leave(room, input.playerId);
    if (updated.players.length === 0) {
      await this.rooms.delete(room.code);
      return null;
    }
    await this.rooms.save(updated);
    return updated;
  }

  private async requireRoom(code: string): Promise<Room> {
    const room = await this.rooms.findByCode(code);
    if (!room) throw new DomainError("ROOM_NOT_FOUND", `Room ${code} does not exist`);
    return room;
  }
}
