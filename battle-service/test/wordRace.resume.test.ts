import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, describe, it } from "node:test";
import { AwardWordBonus } from "../src/application/usecases/AwardWordBonus.js";
import { ExpireWordRound } from "../src/application/usecases/ExpireWordRound.js";
import { OpenWordRound } from "../src/application/usecases/OpenWordRound.js";
import { ResumeWordRace } from "../src/application/usecases/ResumeWordRace.js";
import { StartWordRace } from "../src/application/usecases/StartWordRace.js";
import { StopWordRace } from "../src/application/usecases/StopWordRace.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";
import { InMemoryWordRaceRepository } from "../src/infrastructure/persistence/InMemoryWordRaceRepository.js";
import { WordRaceScheduler } from "../src/infrastructure/scheduling/WordRaceScheduler.js";
import { assertDomainError, battleRoom } from "./support/battles.js";

/**
 * DIS-1: the word race survives the replica that started it. Two schedulers
 * sharing one store stand for two battle-service replicas: rounds are planned
 * with absolute times, any replica can resume them, and every round still opens
 * and ends exactly once, whoever runs the timers.
 */
const OFFSETS_MS = [60, 260, 460];
const WINDOW_MS = 120;

interface Announcement {
  replica: string;
  roundId: string;
}

let rooms: InMemoryRoomRepository;
let races: InMemoryWordRaceRepository;
let started: Announcement[];
let ended: Announcement[];
let code: string;

function replica(name: string): WordRaceScheduler {
  return new WordRaceScheduler({
    startWordRace: new StartWordRace(rooms, races, { offsetsMs: OFFSETS_MS, windowMs: WINDOW_MS }),
    openWordRound: new OpenWordRound(rooms, races),
    expireWordRound: new ExpireWordRound(races),
    stopWordRace: new StopWordRace(races),
    resumeWordRace: new ResumeWordRace(rooms, races),
    broadcaster: {
      roundStarted: (_race, round) => started.push({ replica: name, roundId: round.id }),
      roundEnded: (_race, round) => ended.push({ replica: name, roundId: round.id }),
    },
  });
}

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await sleep(5);
  }
}

function countBy(list: Announcement[], roundId: string): number {
  return list.filter((a) => a.roundId === roundId).length;
}

beforeEach(async () => {
  rooms = new InMemoryRoomRepository();
  races = new InMemoryWordRaceRepository();
  started = [];
  ended = [];
  const room = battleRoom(["a", "b"], ["s"], { now: new Date() });
  await rooms.insert(room);
  code = room.code;
});

describe("WordRaceScheduler.resume (DIS-1)", () => {
  it("lets a replica take over the race of a replica that died: each remaining round opens and ends once", async () => {
    const owner = replica("owner");
    const survivor = replica("survivor");
    const race = await owner.start(code);
    await waitUntil(() => started.length === 1, "round 1 opened by the owner");
    owner.close(); // dies abruptly: its timers are gone, the race stays in the store

    assert.ok(await survivor.resume(code));
    await waitUntil(() => ended.length === race.rounds.length, "every round ended", 4000);
    for (const round of race.rounds) {
      assert.equal(countBy(started, round.id), 1, `round ${round.number} opened once`);
      assert.equal(countBy(ended, round.id), 1, `round ${round.number} ended once`);
    }
    assert.deepEqual(
      started.map((a) => a.replica),
      ["owner", "survivor", "survivor"],
      "the survivor opened the rounds the owner could not",
    );
    assert.equal(ended.find((a) => a.roundId === race.rounds[0].id)?.replica, "survivor", "and closed the open one");
    assert.equal(survivor.pendingTimers(), 0);
  });

  it("two live replicas running the same race still announce each round once", async () => {
    const one = replica("one");
    const two = replica("two");
    const race = await one.start(code);
    await two.resume(code);
    await waitUntil(() => ended.length >= race.rounds.length, "every round ended", 4000);
    await sleep(WINDOW_MS); // a duplicate announcement would show up by now
    for (const round of race.rounds) {
      assert.equal(countBy(started, round.id), 1, `round ${round.number} opened once`);
      assert.equal(countBy(ended, round.id), 1, `round ${round.number} ended once`);
    }
  });

  it("arms each pending round once per replica, however often it resumes", async () => {
    const one = replica("one");
    const two = replica("two");
    const race = await one.start(code);
    await two.resume(code);
    await two.resume(code);
    assert.equal(two.pendingTimers(code), race.rounds.length);
    one.close();
    two.close();
    assert.equal(two.pendingTimers(), 0);
  });

  it("does not resume the race of a battle that is over", async () => {
    const one = replica("one");
    await one.start(code);
    one.close();
    await rooms.update(code, (room) => RoomService.finishBattle(room, "song-end"));
    const two = replica("two");
    assert.equal(await two.resume(code), null);
    assert.equal(two.pendingTimers(), 0);
  });
});

describe("Word bonus paid once per round (DIS-1)", () => {
  it("RoomService.awardWordBonus with a round id counts that round only once", () => {
    let room = battleRoom(["a", "b"], []);
    room = RoomService.awardWordBonus(room, "a", "r1");
    const again = RoomService.awardWordBonus(room, "a", "r1");
    assert.equal(again, room, "the very same room: nothing to store");
    room = RoomService.awardWordBonus(room, "b", "r2");
    assert.deepEqual(room.battle!.wordsWon, { a: 1, b: 1 });
    assert.deepEqual(room.battle!.wordRoundsAwarded, ["r1", "r2"]);
    assertDomainError(() => RoomService.awardWordBonus(room, "s", "r3"), "INVALID_DANCER");
  });

  it("reconcile pays a won round whose bonus was never paid, exactly once", async () => {
    const owner = replica("owner");
    const race = await owner.start(code);
    owner.close();
    const round = race.rounds[0];
    // The claiming replica won the round and died before paying the bonus.
    await races.openRound(code, round.id);
    assert.equal((await races.claimRound(code, round.id, "b", round.opensAt)).claimed, true);

    const award = new AwardWordBonus(rooms);
    const stored = (await races.find(code))!;
    const first = await award.reconcile(stored);
    assert.deepEqual(first.paidRoundIds, [round.id]);
    assert.deepEqual(first.room!.battle!.wordsWon, { a: 0, b: 1 });

    const version = first.room!.version;
    const second = await award.reconcile(stored);
    assert.deepEqual(second.paidRoundIds, []);
    assert.equal(second.room!.version, version, "nothing written the second time");
    // The claimer coming back late (or another replica) cannot pay it again either.
    const late = await award.execute({ roomCode: code, playerId: "b", roundId: round.id });
    assert.deepEqual(late.battle!.wordsWon, { a: 0, b: 1 });
  });

  it("reconcile leaves battles started before paid rounds were tracked untouched", async () => {
    const owner = replica("owner");
    const race = await owner.start(code);
    owner.close();
    await rooms.update(code, (room) => ({ ...room, battle: { ...room.battle!, wordRoundsAwarded: undefined } }));
    await races.openRound(code, race.rounds[0].id);
    await races.claimRound(code, race.rounds[0].id, "a", race.rounds[0].opensAt);
    const result = await new AwardWordBonus(rooms).reconcile((await races.find(code))!);
    assert.deepEqual(result.paidRoundIds, []);
    assert.deepEqual(result.room!.battle!.wordsWon, { a: 0, b: 0 });
  });
});
