import type { WordRace, WordRound } from "../../domain/model/WordRace.js";
import type { ClaimRoundResult, WordRaceRepository } from "../../domain/ports/WordRaceRepository.js";

/**
 * Process-local word race store.
 *
 * Every compare-and-set method reads, checks and writes inside ONE synchronous
 * block (no `await` between the read and the write). Node runs that block to
 * completion before any other callback, which makes it the in-memory equivalent
 * of a Lua script in Redis or a conditional UPDATE in SQL. Races are stored and
 * returned as copies so callers can never mutate the stored state by accident.
 */
export class InMemoryWordRaceRepository implements WordRaceRepository {
  private readonly races = new Map<string, WordRace>();

  async save(race: WordRace): Promise<void> {
    this.races.set(key(race.roomCode), structuredClone(race));
  }

  async find(roomCode: string): Promise<WordRace | undefined> {
    const race = this.races.get(key(roomCode));
    return race ? structuredClone(race) : undefined;
  }

  async delete(roomCode: string): Promise<void> {
    this.races.delete(key(roomCode));
  }

  async openRound(roomCode: string, roundId: string): Promise<WordRound | null> {
    // --- critical section (synchronous) ---
    const race = this.races.get(key(roomCode));
    const round = race?.rounds.find((r) => r.id === roundId);
    if (!race || !round || round.status !== "scheduled") return null;
    const opened: WordRound = { ...round, status: "open" };
    this.races.set(key(roomCode), withRound(race, opened));
    return structuredClone(opened);
  }

  async claimRound(roomCode: string, roundId: string, playerId: string, now: Date): Promise<ClaimRoundResult> {
    // --- critical section (synchronous) ---
    const race = this.races.get(key(roomCode));
    const round = race?.rounds.find((r) => r.id === roundId);
    if (!race || !round) return { claimed: false, round: null };
    const claimable =
      round.status === "open" && round.winnerId === null && now.getTime() < round.closesAt.getTime();
    if (!claimable) return { claimed: false, round: structuredClone(round) };

    const won: WordRound = { ...round, status: "won", winnerId: playerId };
    const wins = { ...race.wins, [playerId]: (race.wins[playerId] ?? 0) + 1 };
    this.races.set(key(roomCode), { ...withRound(race, won), wins });
    return { claimed: true, round: structuredClone(won) };
  }

  async expireRound(roomCode: string, roundId: string, now: Date): Promise<WordRound | null> {
    // --- critical section (synchronous) ---
    const race = this.races.get(key(roomCode));
    const round = race?.rounds.find((r) => r.id === roundId);
    if (!race || !round) return null;
    const expirable =
      round.status === "open" && round.winnerId === null && now.getTime() >= round.closesAt.getTime();
    if (!expirable) return null;

    const expired: WordRound = { ...round, status: "expired" };
    this.races.set(key(roomCode), withRound(race, expired));
    return structuredClone(expired);
  }
}

function key(roomCode: string): string {
  return roomCode.toUpperCase();
}

function withRound(race: WordRace, round: WordRound): WordRace {
  return { ...race, rounds: race.rounds.map((r) => (r.id === round.id ? round : r)) };
}
