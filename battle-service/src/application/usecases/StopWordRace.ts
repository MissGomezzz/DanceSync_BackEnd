import type { WordRaceRepository } from "../../domain/ports/WordRaceRepository.js";

export interface StopWordRaceInput {
  roomCode: string;
}

/** Discards the race of a room whose battle finished or that no longer exists. */
export class StopWordRace {
  constructor(private readonly races: WordRaceRepository) {}

  async execute(input: StopWordRaceInput): Promise<void> {
    await this.races.delete(input.roomCode);
  }
}
