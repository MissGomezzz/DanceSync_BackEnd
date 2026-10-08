import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainError } from "../src/domain/errors/DomainError.js";
import type { Room } from "../src/domain/model/Room.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { startable } from "./support/ready.js";

function assertDomainError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code);
}

/** Battling room: dancers a and b, spectators s1 and s2. */
function battling(): Room {
  let room = RoomService.create({ id: "a", displayName: "A" }, "ROOM01");
  for (const id of ["b", "s1", "s2"]) room = RoomService.join(room, { id, displayName: id.toUpperCase() });
  room = RoomService.selectRole(room, "a", "dancer");
  room = RoomService.selectRole(room, "b", "dancer");
  room = RoomService.selectRole(room, "s1", "spectator");
  room = RoomService.selectRole(room, "s2", "spectator");
  return RoomService.startBattle(startable(room));
}

function rateAll(room: Room, scores: Record<string, Record<string, number>>): Room {
  let current = room;
  for (const [raterId, perDancer] of Object.entries(scores)) {
    for (const [dancerId, score] of Object.entries(perDancer)) {
      current = RoomService.rate(current, { raterId, dancerId, score });
    }
  }
  return current;
}

describe("Word race bonus in the battle score", () => {
  it("a battle starts with no bonus for any dancer", () => {
    assert.deepEqual(battling().battle!.bonusPoints, { a: 0, b: 0 });
  });

  it("adds the bonus to the winner's current performance right away", () => {
    let room = RoomService.awardWordBonus(battling(), "a", 1);
    assert.deepEqual(room.battle!.bonusPoints, { a: 1, b: 0 });
    room = RoomService.awardWordBonus(room, "a", 2);
    assert.deepEqual(room.battle!.bonusPoints, { a: 3, b: 0 });
  });

  it("the final score is the ratings plus the bonus, and the bonus can decide the winner", () => {
    let room = RoomService.awardWordBonus(battling(), "b", 1);
    room = rateAll(room, { s1: { a: 4, b: 3 }, s2: { a: 4, b: 4 } });
    const finished = RoomService.finishBattle(room);
    // a: 4 + 4 = 8; b: 3 + 4 + 1 bonus = 8 -> a tie that only exists because of the bonus.
    assert.deepEqual(finished.battle!.result, { scores: { a: 8, b: 8 }, winnerId: null });

    const decided = RoomService.finishBattle(RoomService.awardWordBonus(room, "b", 1));
    assert.deepEqual(decided.battle!.result, { scores: { a: 8, b: 9 }, winnerId: "b" });
  });

  it("without any correct word the base points stay exactly as they were", () => {
    const room = rateAll(battling(), { s1: { a: 4, b: 3 }, s2: { a: 5, b: 2 } });
    assert.deepEqual(RoomService.finishBattle(room).battle!.result, { scores: { a: 9, b: 5 }, winnerId: "a" });
  });

  it("refuses a bonus for someone who is not dancing, after the battle, or with a bad amount", () => {
    const room = battling();
    assertDomainError(() => RoomService.awardWordBonus(room, "s1", 1), "INVALID_DANCER");
    assertDomainError(() => RoomService.awardWordBonus(room, "ghost", 1), "INVALID_DANCER");
    for (const points of [0, -1, 1.5, Number.NaN]) {
      assertDomainError(() => RoomService.awardWordBonus(room, "a", points), "INVALID_SCORE");
    }
    assertDomainError(() => RoomService.awardWordBonus(RoomService.finishBattle(room), "a", 1), "ROOM_NOT_BATTLING");
  });

  it("a dancer who leaves takes their bonus out of the result", () => {
    let room = RoomService.awardWordBonus(battling(), "a", 1);
    room = RoomService.leave(room, "a");
    assertDomainError(() => RoomService.awardWordBonus(room, "a", 1), room.status === "finished" ? "ROOM_NOT_BATTLING" : "INVALID_DANCER");
  });
});
