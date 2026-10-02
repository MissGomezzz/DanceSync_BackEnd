import type { WordRace, WordRound } from "../../domain/model/WordRace.js";
import type { WordRaceBroadcaster } from "../scheduling/WordRaceScheduler.js";
import { ServerEvents, type WordRoundEndedPayload, type WordRoundStartedPayload } from "./events.js";
import type { BattleServer } from "./socketHandlers.js";

export function roundStartedPayload(race: WordRace, round: WordRound, now: Date): WordRoundStartedPayload {
  return {
    roomCode: race.roomCode,
    roundId: round.id,
    roundNumber: round.number,
    totalRounds: race.rounds.length,
    word: round.word,
    // Relative time computed here, so clients with a skewed clock still count down correctly.
    expiresInMs: Math.max(0, round.closesAt.getTime() - now.getTime()),
  };
}

export function roundEndedPayload(race: WordRace, round: WordRound): WordRoundEndedPayload {
  const winnerId = round.status === "won" ? round.winnerId : null;
  return {
    roomCode: race.roomCode,
    roundId: round.id,
    roundNumber: round.number,
    totalRounds: race.rounds.length,
    word: round.word,
    winnerId,
    winnerName: winnerId ? (race.participantNames[winnerId] ?? null) : null,
    reason: round.status === "won" ? "won" : "expired",
    wins: { ...race.wins },
  };
}

/** Broadcasts word race events to everyone in the room (dancers and spectators). */
export function createSocketWordRaceBroadcaster(io: BattleServer): WordRaceBroadcaster {
  return {
    roundStarted(race, round, now) {
      io.to(race.roomCode).emit(ServerEvents.WORD_ROUND_STARTED, roundStartedPayload(race, round, now));
    },
    roundEnded(race, round) {
      io.to(race.roomCode).emit(ServerEvents.WORD_ROUND_ENDED, roundEndedPayload(race, round));
    },
  };
}
