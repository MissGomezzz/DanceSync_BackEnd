import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";
import { updateRoom } from "../roomUpdates.js";

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
  constructor(
    private readonly rooms: RoomRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(input: RateDancerInput): Promise<RateDancerOutput> {
    let finished = false;
    const now = this.clock();
    const room = await updateRoom(this.rooms, input.roomCode, (current) => {
      const rated = RoomService.rate(
        current,
        { raterId: input.raterId, dancerId: input.dancerId, score: input.score },
        now,
      );
      // Decided on the latest state: of several concurrent ratings exactly the
      // one that completes the set sees it and finishes the battle.
      finished = RoomService.allRatingsSubmitted(rated);
      return finished ? RoomService.finishBattle(rated) : rated;
    });
    return { room, finished };
  }
}
