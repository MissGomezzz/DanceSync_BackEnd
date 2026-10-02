import type { WordRace, WordRound } from "../../domain/model/WordRace.js";
import type { WordRaceRepository } from "../../domain/ports/WordRaceRepository.js";

export interface GetActiveWordRoundInput {
  roomCode: string;
}

/** The round currently on screen, used to resync a client that (re)joins mid-round. */
export class GetActiveWordRound {
  constructor(
    private readonly races: WordRaceRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(input: GetActiveWordRoundInput): Promise<{ race: WordRace; round: WordRound } | null> {
    const race = await this.races.find(input.roomCode);
    const now = this.clock().getTime();
    const round = race?.rounds.find((r) => r.status === "open" && now < r.closesAt.getTime());
    return race && round ? { race, round } : null;
  }
}
