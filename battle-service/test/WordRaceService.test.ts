import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainError } from "../src/domain/errors/DomainError.js";
import type { Room } from "../src/domain/model/Room.js";
import type { WordRound } from "../src/domain/model/WordRace.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import type { RandomIndex } from "../src/domain/services/SongSelectionService.js";
import { WordRaceService } from "../src/domain/services/WordRaceService.js";

const first: RandomIndex = () => 0;
const last: RandomIndex = (n) => n - 1;

/** Small deterministic PRNG (LCG) so property-style checks are reproducible. */
function seeded(seed: number): RandomIndex {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
}

/** Battling room: host + dancers a, b and spectator s. */
function battling(durationSeconds: number | null = null): Room {
  let room = RoomService.create({ id: "host", displayName: "Host" }, "ROOM01");
  for (const id of ["a", "b", "s"]) room = RoomService.join(room, { id, displayName: id.toUpperCase() });
  room = RoomService.selectRole(room, "a", "dancer");
  room = RoomService.selectRole(room, "b", "dancer");
  room = RoomService.selectRole(room, "s", "spectator");
  room = RoomService.startBattle(room);
  if (durationSeconds === null) return room;
  return { ...room, battle: { ...room.battle!, song: { id: "x", title: "X", artist: "Y", durationSeconds } } };
}

function offsets(room: Room, rounds: WordRound[]): number[] {
  return rounds.map((r) => r.opensAt.getTime() - room.battle!.startedAt.getTime());
}

function openRound(overrides: Partial<WordRound> = {}): WordRound {
  return {
    id: "battle:1",
    number: 1,
    word: "ritmo",
    opensAt: new Date(0),
    closesAt: new Date(10_000),
    winnerId: null,
    status: "open",
    ...overrides,
  };
}

function assertDomainError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code);
}

describe("WordRaceService.plan", () => {
  it("places every round inside the song margins, respecting the window and the minimum gap", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const room = battling(); // no song: 90 s fallback
      const race = WordRaceService.plan(room, { random: seeded(seed) });
      assert.equal(race.rounds.length, 3);
      const opens = offsets(room, race.rounds);
      for (const [i, round] of race.rounds.entries()) {
        assert.ok(opens[i] >= 9_000, `round opens before the start margin (${opens[i]})`);
        assert.ok(opens[i] + 10_000 <= 76_500, `round closes after the end margin (${opens[i]})`);
        assert.equal(round.closesAt.getTime() - round.opensAt.getTime(), 10_000);
        if (i > 0) assert.ok(opens[i] - opens[i - 1] >= 12_000, "rounds are closer than the minimum gap");
      }
    }
  });

  it("uses the song duration for the timeline when the battle has a song", () => {
    const room = battling(209);
    const race = WordRaceService.plan(room, { random: last });
    const lastRound = race.rounds.at(-1)!;
    const closesAfterStart = lastRound.closesAt.getTime() - room.battle!.startedAt.getTime();
    assert.ok(closesAfterStart <= 209_000 * 0.85);
    assert.ok(closesAfterStart > 90_000, "the 90 s fallback was used instead of the song length");
  });

  it("plans fewer rounds when the song is too short to fit them, and none when not even one fits", () => {
    // 30 s song: usable openings in [3 s, 15.5 s] -> only two rounds 12 s apart fit.
    const short = WordRaceService.plan(battling(30), { random: first });
    assert.equal(short.rounds.length, 2);
    assert.deepEqual(
      short.rounds.map((r) => r.number),
      [1, 2],
    );
    assert.equal(WordRaceService.plan(battling(10), { random: first }).rounds.length, 0);
  });

  it("never overlaps windows even when the minimum gap is shorter than the window", () => {
    const room = battling();
    const race = WordRaceService.plan(room, { random: seeded(7), minGapMs: 1_000, windowMs: 10_000 });
    for (let i = 1; i < race.rounds.length; i++) {
      assert.ok(race.rounds[i].opensAt.getTime() >= race.rounds[i - 1].closesAt.getTime());
    }
  });

  it("picks a distinct word for every round", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const words = WordRaceService.plan(battling(), { random: seeded(seed), rounds: 5, minGapMs: 5_000, windowMs: 5_000 })
        .rounds.map((r) => r.word);
      assert.equal(new Set(words).size, words.length);
    }
    const fromTinyPool = WordRaceService.plan(battling(), { random: first, words: ["giro", "paso"] });
    assert.deepEqual(fromTinyPool.rounds.map((r) => r.word), ["giro", "paso"]);
  });

  it("is deterministic with an injected random source", () => {
    const room = battling();
    const a = WordRaceService.plan(room, { random: seeded(42) });
    const b = WordRaceService.plan(room, { random: seeded(42) });
    assert.deepEqual(a, b);
  });

  it("accepts explicit opening offsets (test override)", () => {
    const room = battling();
    const race = WordRaceService.plan(room, { offsetsMs: [300, 50], windowMs: 100, random: first });
    assert.deepEqual(offsets(room, race.rounds), [50, 300]);
    assert.ok(race.rounds.every((r) => r.status === "scheduled" && r.winnerId === null));
  });

  it("snapshots the dancers as participants with zero wins", () => {
    const race = WordRaceService.plan(battling(), { random: first });
    assert.deepEqual(race.participantIds, ["a", "b"]);
    assert.deepEqual(race.participantNames, { a: "A", b: "B" });
    assert.deepEqual(race.wins, { a: 0, b: 0 });
    assert.equal(race.roomCode, "ROOM01");
  });

  it("requires a battle in progress", () => {
    const lobby = RoomService.create({ id: "host", displayName: "Host" });
    assertDomainError(() => WordRaceService.plan(lobby), "ROOM_NOT_BATTLING");
  });
});

describe("WordRaceService.judge", () => {
  const dancers = ["a", "b"];
  const before = new Date(5_000);

  it("accepts the exact word, ignoring case and surrounding whitespace", () => {
    assert.equal(WordRaceService.judge(openRound(), dancers, "a", "ritmo", before), "correct");
    assert.equal(WordRaceService.judge(openRound(), dancers, "a", "  RiTmO \n", before), "correct");
  });

  it("rejects a misspelling without locking the dancer out", () => {
    const round = openRound();
    assert.equal(WordRaceService.judge(round, dancers, "a", "ritmi", before), "incorrect");
    assert.equal(WordRaceService.judge(round, dancers, "a", "ritmo", before), "correct");
  });

  it("reports attempts at or after closesAt, or on an expired round, as expired", () => {
    assert.equal(WordRaceService.judge(openRound(), dancers, "a", "ritmo", new Date(10_000)), "expired");
    assert.equal(WordRaceService.judge(openRound({ status: "expired" }), dancers, "a", "ritmo", before), "expired");
  });

  it("only lets the battle's dancers take part", () => {
    assertDomainError(() => WordRaceService.judge(openRound(), dancers, "s", "ritmo", before), "NOT_CHALLENGE_PARTICIPANT");
  });

  it("rejects attempts on a round that has not opened yet", () => {
    assertDomainError(
      () => WordRaceService.judge(openRound({ status: "scheduled" }), dancers, "a", "ritmo", before),
      "WORD_ROUND_NOT_OPEN",
    );
  });

  it("does not decide the winner: a correct word on a won round is still just 'correct'", () => {
    // The atomic claim in the repository is what turns this into "late".
    const won = openRound({ status: "won", winnerId: "b" });
    assert.equal(WordRaceService.judge(won, dancers, "a", "ritmo", before), "correct");
  });
});
