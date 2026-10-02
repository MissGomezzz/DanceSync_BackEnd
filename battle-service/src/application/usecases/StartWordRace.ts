import { DomainError } from "../../domain/errors/DomainError.js";
import type { WordRace } from "../../domain/model/WordRace.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import type { WordRaceRepository } from "../../domain/ports/WordRaceRepository.js";
import { WordRaceService, type PlanWordRaceOptions } from "../../domain/services/WordRaceService.js";

export interface StartWordRaceInput {
  roomCode: string;
}

/** Plans the word race of a battle that just started and stores it (replacing any previous one). */
export class StartWordRace {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly races: WordRaceRepository,
    private readonly options: PlanWordRaceOptions = {},
  ) {}

  async execute(input: StartWordRaceInput): Promise<WordRace> {
    const room = await this.rooms.findByCode(input.roomCode);
    if (!room) throw new DomainError("ROOM_NOT_FOUND", `Room ${input.roomCode} does not exist`);
    const race = WordRaceService.plan(room, this.options);
    await this.races.save(race);
    return race;
  }
}
