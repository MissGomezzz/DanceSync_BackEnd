import type { Room } from "../../domain/model/Room.js";
import { DEFAULT_WORD_BONUS_POINTS } from "../../domain/model/WordRace.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";
import { updateRoom } from "../roomUpdates.js";

export interface AwardWordBonusInput {
  roomCode: string;
  /** The dancer who won the word round. */
  playerId: string;
}

/**
 * Adds the word round bonus to the winner's performance. Called once per round,
 * by the one submission that won the atomic claim, so a round is paid only once.
 */
export class AwardWordBonus {
  constructor(
    private readonly rooms: RoomRepository,
    readonly points: number = DEFAULT_WORD_BONUS_POINTS,
  ) {}

  async execute(input: AwardWordBonusInput): Promise<Room> {
    return updateRoom(this.rooms, input.roomCode, (room) => RoomService.awardWordBonus(room, input.playerId, this.points));
  }
}
