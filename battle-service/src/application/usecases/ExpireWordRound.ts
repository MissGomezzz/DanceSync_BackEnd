import type { WordRace, WordRound } from "../../domain/model/WordRace.js";
import type { WordRaceRepository } from "../../domain/ports/WordRaceRepository.js";

export interface ExpireWordRoundInput {
  roomCode: string;
  roundId: string;
}

/**
 * expired: false with the round still "open" means the timer fired a moment
 * before closesAt; the caller should try again for the remaining time.
 */
export type ExpireWordRoundOutput =
  | { expired: true; round: WordRound; race: WordRace }
  | { expired: false; round: WordRound | null };

export class ExpireWordRound {
  constructor(
    private readonly races: WordRaceRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(input: ExpireWordRoundInput): Promise<ExpireWordRoundOutput> {
    // The repository decides atomically; this use case never expires from its own read.
    const expired = await this.races.expireRound(input.roomCode, input.roundId, this.clock());
    const race = await this.races.find(input.roomCode);
    if (expired && race) return { expired: true, round: expired, race };
    return { expired: false, round: race?.rounds.find((r) => r.id === input.roundId) ?? null };
  }
}
