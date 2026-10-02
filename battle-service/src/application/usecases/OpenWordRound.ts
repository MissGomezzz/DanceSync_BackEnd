import type { WordRace, WordRound } from "../../domain/model/WordRace.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import type { WordRaceRepository } from "../../domain/ports/WordRaceRepository.js";

export interface OpenWordRoundInput {
  roomCode: string;
  roundId: string;
}

/**
 * - battle-over: the room is gone or its battle is no longer running; stop the race.
 * - not-scheduled: the round was already opened, belongs to an older race, or the race is gone.
 */
export type OpenWordRoundOutput =
  | { opened: true; round: WordRound; race: WordRace }
  | { opened: false; reason: "battle-over" | "not-scheduled" };

export class OpenWordRound {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly races: WordRaceRepository,
  ) {}

  async execute(input: OpenWordRoundInput): Promise<OpenWordRoundOutput> {
    const room = await this.rooms.findByCode(input.roomCode);
    const race = await this.races.find(input.roomCode);
    if (!race) return { opened: false, reason: "not-scheduled" };
    if (!room || room.status !== "battling" || room.battle?.id !== race.battleId) {
      return { opened: false, reason: "battle-over" };
    }
    const round = await this.races.openRound(input.roomCode, input.roundId);
    if (!round) return { opened: false, reason: "not-scheduled" };
    return { opened: true, round, race };
  }
}
