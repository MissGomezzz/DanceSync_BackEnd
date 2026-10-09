import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StartRematch } from "../src/application/usecases/StartRematch.js";
import type { Room } from "../src/domain/model/Room.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";
import { assertDomainError, at, battleRoom } from "./support/battles.js";

function finishedRoom(): Room {
  let room = battleRoom(["a", "b"], ["s1", "s2"]);
  room = RoomService.castVote(room, "s1", "b", at(1_000));
  room = RoomService.awardWordBonus(room, "a");
  return RoomService.finishAtDeadline(room, room.battle!.endsAt);
}

describe("Battle end at the song end (HU 18)", () => {
  it("finishes exactly when the song clip ends, with the standings and the winner", () => {
    const room = finishedRoom();
    assert.equal(room.status, "finished");
    assert.equal(room.battle!.endReason, "song-end");
    assert.equal(room.battle!.finishedAt!.getTime(), room.battle!.endsAt.getTime());
    assert.deepEqual(room.battle!.result, {
      standings: [
        { dancerId: "b", displayName: "B", votes: 1, wordsWon: 0, score: 2, rank: 1 },
        { dancerId: "a", displayName: "A", votes: 0, wordsWon: 1, score: 1, rank: 2 },
      ],
      winnerId: "b",
    });
    assert.deepEqual(room.lastResult, room.battle!.result);
  });
});

describe("Rematch (HU 18)", () => {
  it("takes the room back to the lobby with the same players and roles, ready flags reset", () => {
    const finished = finishedRoom();
    const room = RoomService.rematch(finished, "a");
    assert.equal(room.status, "waiting");
    assert.equal(room.battle, null);
    assert.equal(room.songSelection, null);
    assert.equal(room.selectedSong, null, "the song selection restarts");
    assert.equal(room.dancers, null);
    assert.deepEqual(
      room.players.map((p) => [p.id, p.role, p.ready]),
      [
        ["a", "dancer", false],
        ["b", "dancer", false],
        ["s1", "spectator", false],
        ["s2", "spectator", false],
      ],
    );
    assert.deepEqual(room.spectators.map((p) => p.id), ["s1", "s2"]);
    assert.deepEqual(room.lastResult, finished.battle!.result, "the last result stays visible in the lobby");
  });

  it("only the host can ask for it (NOT_HOST), and only once the battle is finished (ROOM_NOT_FINISHED)", () => {
    const finished = finishedRoom();
    assertDomainError(() => RoomService.rematch(finished, "b"), "NOT_HOST");
    assertDomainError(() => RoomService.rematch(finished, "s1"), "NOT_HOST");
    const running = battleRoom(["a", "b"], []);
    assertDomainError(() => RoomService.rematch(running, "a"), "ROOM_NOT_FINISHED");
    assertDomainError(() => RoomService.rematch(RoomService.rematch(finished, "a"), "a"), "ROOM_NOT_FINISHED");
  });

  it("a new battle can be played after it, starting from fresh votes and word counts", () => {
    let room = RoomService.rematch(finishedRoom(), "a");
    room = room.players.reduce((current, p) => RoomService.setReady(current, p.id, true), room);
    room = RoomService.startBattle({ ...room, selectedSong: finishedRoom().battle!.song }, undefined, { now: at(0) });
    assert.equal(room.status, "battling");
    assert.deepEqual(room.battle!.votes, {});
    assert.deepEqual(room.battle!.wordsWon, { a: 0, b: 0 });
    assert.equal(room.lastResult?.winnerId, "b", "the previous result is kept until this battle finishes");
  });

  it("the use case reports the spectators whose vote the rematch cleared", async () => {
    const rooms = new InMemoryRoomRepository();
    await rooms.insert(finishedRoom());
    const { room, clearedVoterIds } = await new StartRematch(rooms).execute({ roomCode: "ROOM01", requesterId: "a" });
    assert.equal(room.status, "waiting");
    assert.deepEqual(clearedVoterIds, ["s1"]);
  });
});
