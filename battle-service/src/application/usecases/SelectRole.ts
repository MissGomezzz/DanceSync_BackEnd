import { DomainError } from "../../domain/errors/DomainError.js";
import type { Player } from "../../domain/model/Player.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";

export interface SelectRoleInput {
  roomCode: string;
  playerId: string;
  role: Exclude<Player["role"], "undecided">;
}

export class SelectRole {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: SelectRoleInput): Promise<Room> {
    const room = await this.rooms.findByCode(input.roomCode);
    if (!room) throw new DomainError("ROOM_NOT_FOUND", `Room ${input.roomCode} does not exist`);
    const updated = RoomService.selectRole(room, input.playerId, input.role);
    await this.rooms.save(updated);
    return updated;
  }
}