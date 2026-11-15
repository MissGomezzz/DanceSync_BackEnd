import type { WordRace } from "../../domain/model/WordRace.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import type { WordRaceRepository } from "../../domain/ports/WordRaceRepository.js";

export interface ResumeWordRaceInput {
  roomCode: string;
}

/**
 * - active: the race belongs to the battle the room is running; its pending
 *   rounds must have timers on some replica.
 * - no-race: nothing was planned (or it was already discarded).
 * - battle-over: the room is gone, not battling, or running another battle.
 */
export type ResumeWordRaceOutput =
  | { active: true; race: WordRace }
  | { active: false; reason: "no-race" | "battle-over" };

/**
 * Reads the stored word race of a room so any replica can take over its timers
 * (DIS-1). Round times are absolute (opensAt / closesAt), so the race can be
 * resumed exactly where it is, whichever replica planned it.
 */
export class ResumeWordRace {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly races: WordRaceRepository,
  ) {}

  async execute(input: ResumeWordRaceInput): Promise<ResumeWordRaceOutput> {
    const race = await this.races.find(input.roomCode);
    if (!race) return { active: false, reason: "no-race" };
    const room = await this.rooms.findByCode(input.roomCode);
    if (!room || room.status !== "battling" || room.battle?.id !== race.battleId) {
      return { active: false, reason: "battle-over" };
    }
    return { active: true, race };
  }
}
