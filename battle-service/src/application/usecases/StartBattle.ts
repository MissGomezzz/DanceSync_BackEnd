import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";

export interface StartBattleInput {
  roomCode: string;
  /** Player requesting the start; must be the room host. */
  requesterId: string;
  /** Overrides the dancers chosen through role:select; at least MIN_DANCERS_PER_BATTLE ids. */
  dancerIds?: string[];
}

export class StartBattle {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: StartBattleInput): Promise<Room> {
    const room = await this.rooms.findByCode(input.roomCode);
    if (!room) throw new DomainError("ROOM_NOT_FOUND", `Room ${input.roomCode} does not exist`);
    if (room.hostId !== input.requesterId) {
      throw new DomainError("NOT_HOST", "Only the host can start the battle");
    }
    const updated = RoomService.startBattle(room, input.dancerIds);
    await this.rooms.save(updated);
    return updated;
  }
}
