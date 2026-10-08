import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainError } from "../src/domain/errors/DomainError.js";
import type { Room } from "../src/domain/model/Room.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { startable } from "./support/ready.js";

function assertDomainError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code);
}

/** Running battle with the given dancers and spectators; "host" is the first dancer. */
function battle(dancers: string[], spectators: string[]): Room {
  const [hostId, ...others] = [...dancers, ...spectators];
  let room = RoomService.create({ id: hostId, displayName: hostId.toUpperCase() }, "ROOM01");
  for (const id of others) room = RoomService.join(room, { id, displayName: id.toUpperCase() });
  for (const id of dancers) room = RoomService.selectRole(room, id, "dancer");
  for (const id of spectators) room = RoomService.selectRole(room, id, "spectator");
  return RoomService.startBattle(startable(room));
}

function rate(room: Room, raterId: string, dancerId: string, score: number): Room {
  return RoomService.rate(room, { raterId, dancerId, score });
}

describe("RoomService.leave during a battle", () => {
  it("a dancer leaving with two or more dancers left keeps the battle running without them", () => {
    let room = battle(["a", "b", "c"], ["s"]);
    room = rate(room, "s", "c", 5);
    room = RoomService.leave(room, "c");

    assert.equal(room.status, "battling");
    assert.deepEqual(room.battle!.dancerIds, ["a", "b"]);
    assert.deepEqual(room.dancers!.map((d) => d.id), ["a", "b"]);
    assert.deepEqual(room.spectators.map((p) => p.id), ["s"]);
    assert.equal(room.battle!.result, null);
    // The rating already given to the departed dancer stays as history...
    assert.deepEqual(room.battle!.ratings.map((r) => r.dancerId), ["c"]);
    // ...but they can no longer be rated.
    assertDomainError(() => rate(room, "s", "c", 3), "INVALID_DANCER");
  });

  it("a dancer leaving with fewer than the minimum left ends the battle early without a result", () => {
    let room = battle(["a", "b"], ["s"]);
    room = rate(room, "s", "a", 4);
    room = RoomService.leave(room, "b");

    assert.equal(room.status, "finished");
    assert.equal(room.battle!.result, null);
    assert.ok(room.battle!.finishedAt instanceof Date);
    assert.deepEqual(room.battle!.dancerIds, ["a"]);
    assert.deepEqual(room.dancers!.map((d) => d.id), ["a"]);
  });

  it("does not require ratings for a departed dancer and excludes theirs from the result", () => {
    let room = battle(["a", "b", "c"], ["s"]);
    room = rate(room, "s", "c", 5);
    room = RoomService.leave(room, "c");
    room = rate(room, "s", "a", 2);
    assert.equal(RoomService.allRatingsSubmitted(room), false);
    room = rate(room, "s", "b", 3);
    assert.equal(RoomService.allRatingsSubmitted(room), true);

    const finished = RoomService.finishBattle(room);
    assert.deepEqual(finished.battle!.result, { scores: { a: 2, b: 3 }, winnerId: "b" });
    assert.equal(finished.battle!.ratings.length, 3, "the departed dancer's rating is kept in the record");
  });

  it("finishes with a result when a departing dancer was the only one still missing ratings", () => {
    let room = battle(["a", "b", "c"], ["s"]);
    room = rate(room, "s", "a", 4);
    room = rate(room, "s", "b", 1);
    room = RoomService.leave(room, "c");

    assert.equal(room.status, "finished");
    assert.deepEqual(room.battle!.result, { scores: { a: 4, b: 1 }, winnerId: "a" });
  });

  it("finishes with a result when the spectator who had not rated yet leaves", () => {
    let room = battle(["a", "b"], ["s1", "s2"]);
    room = rate(room, "s1", "a", 3);
    room = rate(room, "s1", "b", 5);
    room = rate(room, "s2", "a", 1);
    assert.equal(RoomService.allRatingsSubmitted(room), false);
    room = RoomService.leave(room, "s2");

    assert.equal(room.status, "finished");
    // Ratings from a spectator who left still count.
    assert.deepEqual(room.battle!.result, { scores: { a: 4, b: 5 }, winnerId: "b" });
  });

  it("a departed spectator's ratings cannot complete the battle for the ones who stay", () => {
    let room = battle(["a", "b"], ["s1", "s2"]);
    room = rate(room, "s1", "a", 3);
    room = rate(room, "s1", "b", 5);
    room = rate(room, "s2", "a", 1);
    room = RoomService.leave(room, "s1");

    // Three ratings exist and only two are expected now, but s2 still owes one.
    assert.equal(room.status, "battling");
    assert.equal(RoomService.allRatingsSubmitted(room), false);
  });

  it("the last spectator leaving does not end the battle", () => {
    const room = RoomService.leave(battle(["a", "b"], ["s"]), "s");
    assert.equal(room.status, "battling");
    assert.equal(room.battle!.result, null);
  });
});

describe("RoomService.leave in the lobby", () => {
  it("keeps the other players' chosen roles", () => {
    let room = RoomService.create({ id: "host", displayName: "Host" }, "ROOM01");
    for (const id of ["a", "b", "s"]) room = RoomService.join(room, { id, displayName: id });
    room = RoomService.selectRole(room, "a", "dancer");
    room = RoomService.selectRole(room, "s", "spectator");
    room = RoomService.leave(room, "b");

    assert.equal(room.status, "waiting");
    assert.equal(room.dancers, null);
    assert.deepEqual(room.spectators.map((p) => p.id), ["s"]);
    assert.deepEqual(room.players.map((p) => [p.id, p.role]), [
      ["host", "undecided"],
      ["a", "dancer"],
      ["s", "spectator"],
    ]);
  });
});
