import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";

export interface RateDancerInput {
  roomCode: string;
  raterId: string;
  dancerId: string;
  score: number;
}

export interface RateDancerOutput {
  room: Room;
  /** True when this rating completed the battle and a result is now available. */
  finished: boolean;
}

export class RateDancer {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: RateDancerInput): Promise<RateDancerOutput> {
    const room = await this.rooms.findByCode(input.roomCode);
    if (!room) throw new DomainError("ROOM_NOT_FOUND", `Room ${input.roomCode} does not exist`);

    let updated = RoomService.rate(room, {
      raterId: input.raterId,
      dancerId: input.dancerId,
      score: input.score,
    });

    const finished = RoomService.allRatingsSubmitted(updated);
    if (finished) {
      updated = RoomService.finishBattle(updated);
    }

    await this.rooms.save(updated);
    return { room: updated, finished };
  }
}
