import { DomainError } from "../../domain/errors/DomainError.js";
import type { SubmitWordOutcome, WordRace, WordRound } from "../../domain/model/WordRace.js";
import type { WordRaceRepository } from "../../domain/ports/WordRaceRepository.js";
import { WordRaceService } from "../../domain/services/WordRaceService.js";

export interface SubmitWordInput {
  roomCode: string;
  playerId: string;
  roundId: string;
  text: string;
}

export interface SubmitWordOutput {
  outcome: SubmitWordOutcome;
  round: WordRound;
  /** Race state after this submission; on "won" it includes the updated win count. */
  race: WordRace;
}

export class SubmitWord {
  constructor(
    private readonly races: WordRaceRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(input: SubmitWordInput): Promise<SubmitWordOutput> {
    if (typeof input.text !== "string" || typeof input.roundId !== "string") {
      throw new DomainError("INVALID_MESSAGE", "The typed word and the round id must be text");
    }
    const race = await this.races.find(input.roomCode);
    if (!race) throw new DomainError("WORD_RACE_NOT_ACTIVE", `Room ${input.roomCode} has no word race running`);
    const round = race.rounds.find((r) => r.id === input.roundId);
    if (!round) throw new DomainError("WORD_ROUND_NOT_OPEN", `Round ${input.roundId} does not exist`);

    const now = this.clock();
    const verdict = WordRaceService.judge(round, race.participantIds, input.playerId, input.text, now);
    if (verdict !== "correct") return { outcome: verdict, round, race };

    // The read above may already be stale: only the atomic claim decides the winner.
    const claim = await this.races.claimRound(input.roomCode, input.roundId, input.playerId, now);
    if (!claim.round) throw new DomainError("WORD_RACE_NOT_ACTIVE", `Room ${input.roomCode} has no word race running`);
    if (claim.claimed) {
      const updated = (await this.races.find(input.roomCode)) ?? race;
      return { outcome: "won", round: claim.round, race: updated };
    }
    const expiredMeanwhile =
      claim.round.status === "expired" || (claim.round.winnerId === null && now.getTime() >= claim.round.closesAt.getTime());
    return { outcome: expiredMeanwhile ? "expired" : "late", round: claim.round, race };
  }
}
