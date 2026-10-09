import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";
import { updateRoom } from "../roomUpdates.js";

export interface AwardWordBonusInput {
  roomCode: string;
  /** The dancer who won the word round. */
  playerId: string;
}

/**
 * Counts a word round won by the winner (battle.wordsWon); the points it is
 * worth come from the battle's scoring snapshot. Called once per round, by the
 * one submission that won the atomic claim, so a round is counted only once.
 */
export class AwardWordBonus {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: AwardWordBonusInput): Promise<Room> {
    return updateRoom(this.rooms, input.roomCode, (room) => RoomService.awardWordBonus(room, input.playerId));
  }
}
