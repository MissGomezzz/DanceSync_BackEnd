import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Room } from "../src/domain/model/Room.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { assertDomainError, at, battleRoom } from "./support/battles.js";

const DURING = at(1_000);

function vote(room: Room, voterId: string, dancerId: string | null): Room {
  return RoomService.castVote(room, voterId, dancerId, DURING);
}

describe("RoomService.leave during a battle (leavers and votes)", () => {
  it("a spectator who leaves loses their vote; the others' votes stay", () => {
    let room = battleRoom(["a", "b"], ["s1", "s2"]);
    room = vote(room, "s1", "a");
    room = vote(room, "s2", "a");
    room = RoomService.leave(room, "s2", DURING);
    assert.equal(room.status, "battling");
    assert.deepEqual(room.battle!.votes, { s1: "a" });
  });

  it("a dancer leaving with two or more left keeps the battle running; votes for them are discarded", () => {
    let room = battleRoom(["a", "b", "c"], ["s1", "s2"]);
    room = vote(room, "s1", "c");
    room = vote(room, "s2", "a");
    room = RoomService.leave(room, "c", DURING);
    assert.equal(room.status, "battling");
    assert.deepEqual(room.battle!.dancerIds, ["a", "b"]);
    assert.deepEqual(room.battle!.votes, { s2: "a" });
    // The departed dancer stays in the roster (names), but can no longer receive votes...
    assert.deepEqual(room.battle!.roster.map((r) => r.id), ["a", "b", "c"]);
    assertDomainError(() => vote(room, "s1", "c"), "INVALID_DANCER");
    // ...while their former voters can vote again.
    room = vote(room, "s1", "b");
    assert.deepEqual(room.battle!.votes, { s1: "b", s2: "a" });
  });

  it("a dancer leaving with fewer than the minimum left ends the battle early, with a result over who stayed", () => {
    let room = battleRoom(["a", "b"], ["s"]);
    room = vote(room, "s", "b");
    room = RoomService.awardWordBonus(room, "a");
    room = RoomService.leave(room, "b", DURING);
    assert.equal(room.status, "finished");
    assert.equal(room.battle!.endReason, "not-enough-dancers");
    assert.equal(room.battle!.finishedAt!.getTime(), DURING.getTime());
    assert.deepEqual(room.battle!.result, {
      standings: [{ dancerId: "a", displayName: "A", votes: 0, wordsWon: 1, score: 1, rank: 1 }],
      winnerId: "a",
    });
    assert.deepEqual(room.lastResult, room.battle!.result);
  });

  it("leaving after the battle finished changes neither the result nor the frozen votes", () => {
    let room = battleRoom(["a", "b"], ["s"]);
    room = vote(room, "s", "a");
    room = RoomService.finishAtDeadline(room, room.battle!.endsAt);
    const result = room.battle!.result;
    room = RoomService.leave(room, "a", at(999_999));
    assert.deepEqual(room.battle!.result, result);
    assert.equal(room.battle!.result!.winnerId, "a");
  });

  it("the host leaving hands the room over to the next player", () => {
    const room = RoomService.leave(battleRoom(["a", "b", "c"], []), "a", DURING);
    assert.equal(room.hostId, "b");
  });
});
