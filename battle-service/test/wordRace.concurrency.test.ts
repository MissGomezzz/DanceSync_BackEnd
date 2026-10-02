import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { SubmitWord } from "../src/application/usecases/SubmitWord.js";
import type { WordRace, WordRound } from "../src/domain/model/WordRace.js";
import type { ClaimRoundResult, WordRaceRepository } from "../src/domain/ports/WordRaceRepository.js";
import { InMemoryWordRaceRepository } from "../src/infrastructure/persistence/InMemoryWordRaceRepository.js";

/**
 * Concurrency proof for "only one dancer wins a word round".
 *
 * The in-memory store answers synchronously, which hides races. This decorator
 * waits a random 0-5 ms before every call, like a network round trip to Redis or
 * Postgres, so concurrent submissions genuinely interleave between their reads
 * and their writes.
 */
class LatencyWordRaceRepository implements WordRaceRepository {
  private readonly inner: WordRaceRepository;

  constructor(inner: WordRaceRepository) {
    this.inner = inner;
  }

  private async latency(): Promise<void> {
    await sleep(Math.random() * 5);
  }

  async save(race: WordRace): Promise<void> {
    await this.latency();
    return this.inner.save(race);
  }

  async find(roomCode: string): Promise<WordRace | undefined> {
    await this.latency();
    return this.inner.find(roomCode);
  }

  async delete(roomCode: string): Promise<void> {
    await this.latency();
    return this.inner.delete(roomCode);
  }

  async openRound(roomCode: string, roundId: string): Promise<WordRound | null> {
    await this.latency();
    return this.inner.openRound(roomCode, roundId);
  }

  async claimRound(roomCode: string, roundId: string, playerId: string, now: Date): Promise<ClaimRoundResult> {
    await this.latency();
    return this.inner.claimRound(roomCode, roundId, playerId, now);
  }

  async expireRound(roomCode: string, roundId: string, now: Date): Promise<WordRound | null> {
    await this.latency();
    return this.inner.expireRound(roomCode, roundId, now);
  }
}

const ROOM = "RACE01";
const ROUND_ID = "battle:1";
const WORD = "tambor";
const DANCERS = 100;
const ITERATIONS = 50;
const T0 = new Date("2026-01-01T00:00:00.000Z");
const clock = () => new Date(T0.getTime() + 1_000); // inside the window
const participants = Array.from({ length: DANCERS }, (_, i) => `dancer-${i}`);

function openRace(): WordRace {
  return {
    roomCode: ROOM,
    battleId: "battle",
    participantIds: participants,
    participantNames: Object.fromEntries(participants.map((id) => [id, id])),
    rounds: [
      {
        id: ROUND_ID,
        number: 1,
        word: WORD,
        opensAt: T0,
        closesAt: new Date(T0.getTime() + 10_000),
        winnerId: null,
        status: "open",
      },
    ],
    wins: Object.fromEntries(participants.map((id) => [id, 0])),
  };
}

/** Seeds the race directly (no latency needed for setup) and returns the slow view of it. */
async function freshRepository(): Promise<WordRaceRepository> {
  const store = new InMemoryWordRaceRepository();
  await store.save(openRace());
  return new LatencyWordRaceRepository(store);
}

/**
 * DELIBERATELY BROKEN: the plain read -> decide -> save pattern. Every caller can read "no winner yet" before any of them saves, so
 * several dancers are told they won (lost update). Kept only as a negative
 * control proving the concurrency test is able to catch this bug.
 */
async function naiveSubmit(repository: WordRaceRepository, playerId: string): Promise<"won" | "late"> {
  const race = (await repository.find(ROOM))!;
  const round = race.rounds[0];
  if (round.winnerId !== null) return "late";
  const won: WordRound = { ...round, status: "won", winnerId: playerId };
  await repository.save({ ...race, rounds: [won], wins: { ...race.wins, [playerId]: race.wins[playerId] + 1 } });
  return "won";
}

describe("Word race concurrency: only one dancer can win a round", () => {
  it(`${DANCERS} simultaneous correct submissions produce exactly one winner (${ITERATIONS} iterations)`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const repository = await freshRepository();
      const submitWord = new SubmitWord(repository, clock);

      const results = await Promise.all(
        participants.map((playerId) => submitWord.execute({ roomCode: ROOM, roundId: ROUND_ID, playerId, text: WORD })),
      );

      const winners = results.filter((r) => r.outcome === "won");
      const late = results.filter((r) => r.outcome === "late");
      assert.equal(winners.length, 1, `iteration ${iteration}: ${winners.length} winners`);
      assert.equal(late.length, DANCERS - 1, `iteration ${iteration}: ${late.length} late`);

      const winnerId = participants[results.findIndex((r) => r.outcome === "won")];
      const stored = (await repository.find(ROOM))!;
      assert.equal(stored.rounds[0].status, "won");
      assert.equal(stored.rounds[0].winnerId, winnerId);
      assert.ok(late.every((r) => r.round.winnerId === winnerId), "a late dancer was told a different winner");
      const totalWins = Object.values(stored.wins).reduce((sum, n) => sum + n, 0);
      assert.equal(totalWins, 1);
      assert.equal(stored.wins[winnerId], 1);
    }
  });

  it("negative control: the naive read-then-save version DOES produce several winners", async () => {
    // If this ever fails, the latency decorator stopped interleaving the calls and
    // the test above would no longer prove anything.
    let iterationsWithSeveralWinners = 0;
    let maxWinners = 0;
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const repository = await freshRepository();
      const outcomes = await Promise.all(participants.map((playerId) => naiveSubmit(repository, playerId)));
      const winners = outcomes.filter((o) => o === "won").length;
      maxWinners = Math.max(maxWinners, winners);
      if (winners > 1) iterationsWithSeveralWinners++;
    }
    console.log(
      `naive read-then-save: ${iterationsWithSeveralWinners}/${ITERATIONS} iterations told more than one dancer they won (max ${maxWinners})`,
    );
    assert.ok(iterationsWithSeveralWinners > 0, "the naive version never produced several winners");
  });

  it("a claim racing the expiry: exactly one of them takes effect", async () => {
    const insideWindow = new Date(T0.getTime() + 9_999);
    const atClose = new Date(T0.getTime() + 10_000);
    const tally = { claimed: 0, expired: 0 };
    for (let iteration = 0; iteration < 100; iteration++) {
      const repository = await freshRepository();
      const [claim, expired] = await Promise.all([
        repository.claimRound(ROOM, ROUND_ID, "dancer-0", insideWindow),
        repository.expireRound(ROOM, ROUND_ID, atClose),
      ]);
      assert.notEqual(claim.claimed, expired !== null, `iteration ${iteration}: both or neither took effect`);
      const stored = (await repository.find(ROOM))!;
      assert.equal(stored.rounds[0].status, claim.claimed ? "won" : "expired");
      assert.equal(stored.wins["dancer-0"], claim.claimed ? 1 : 0);
      if (claim.claimed) tally.claimed++;
      else tally.expired++;
    }
    console.log(`claim vs expiry: claim won ${tally.claimed} times, expiry won ${tally.expired} times`);
  });

  it("a round opens only once even when the open is triggered concurrently", async () => {
    const repository = new LatencyWordRaceRepository(new InMemoryWordRaceRepository());
    const race = openRace();
    await repository.save({ ...race, rounds: [{ ...race.rounds[0], status: "scheduled" }] });
    const opened = await Promise.all(Array.from({ length: 20 }, () => repository.openRound(ROOM, ROUND_ID)));
    assert.equal(opened.filter((r) => r !== null).length, 1);
  });

  it("the store hands out copies, so callers cannot change a round behind its back", async () => {
    const repository = new InMemoryWordRaceRepository();
    await repository.save(openRace());
    const copy = (await repository.find(ROOM))!;
    copy.rounds[0].winnerId = "cheater";
    copy.rounds[0].status = "won";
    const claim = await repository.claimRound(ROOM, ROUND_ID, "dancer-1", clock());
    assert.equal(claim.claimed, true);
    assert.equal(claim.round.winnerId, "dancer-1");
  });
});
