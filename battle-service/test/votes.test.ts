import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CastVote } from "../src/application/usecases/CastVote.js";
import type { Room } from "../src/domain/model/Room.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";
import { toRoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { assertDomainError, at, battleRoom } from "./support/battles.js";

const COUNTDOWN_MS = 5_000;
const DURING = at(COUNTDOWN_MS + 1_000);

function counting(): Room {
  return battleRoom(["a", "b"], ["s1", "s2"], { countdownMs: COUNTDOWN_MS });
}

describe("Spectator votes (HU 20): cast, move, withdraw", () => {
  it("a spectator casts a vote, moves it to another dancer and withdraws it", () => {
    let room = counting();
    room = RoomService.castVote(room, "s1", "a", DURING);
    assert.deepEqual(room.battle!.votes, { s1: "a" });
    room = RoomService.castVote(room, "s1", "b", DURING);
    assert.deepEqual(room.battle!.votes, { s1: "b" }, "one vote per spectator: moving replaces it");
    room = RoomService.castVote(room, "s1", null, DURING);
    assert.deepEqual(room.battle!.votes, {});
    assert.equal(RoomService.voteOf(room, "s1"), null);
  });

  it("casting the vote already held, or withdrawing none, changes nothing (same room, no write)", () => {
    const voted = RoomService.castVote(counting(), "s1", "a", DURING);
    assert.equal(RoomService.castVote(voted, "s1", "a", DURING), voted);
    assert.equal(RoomService.castVote(voted, "s2", null, DURING), voted);
  });

  it("dancers and non-members cannot vote: INVALID_VOTER", () => {
    const room = counting();
    assertDomainError(() => RoomService.castVote(room, "a", "b", DURING), "INVALID_VOTER");
    assertDomainError(() => RoomService.castVote(room, "a", "a", DURING), "INVALID_VOTER");
    assertDomainError(() => RoomService.castVote(room, "stranger", "a", DURING), "INVALID_VOTER");
  });

  it("votes are refused during the start countdown: BATTLE_NOT_STARTED, accepted from startedAt", () => {
    const room = counting();
    assertDomainError(() => RoomService.castVote(room, "s1", "a", at(COUNTDOWN_MS - 1)), "BATTLE_NOT_STARTED");
    assert.deepEqual(RoomService.castVote(room, "s1", "a", at(COUNTDOWN_MS)).battle!.votes, { s1: "a" });
  });

  it("votes are refused once the song ended (BATTLE_FINISHED), even before the timer closes the battle", () => {
    const room = counting();
    const endsAt = room.battle!.endsAt.getTime() - room.battle!.startedAt.getTime() + COUNTDOWN_MS;
    assert.deepEqual(RoomService.castVote(room, "s1", "b", at(endsAt - 1)).battle!.votes, { s1: "b" });
    assertDomainError(() => RoomService.castVote(room, "s1", "b", at(endsAt)), "BATTLE_FINISHED");
    const finished = RoomService.finishAtDeadline(room, at(endsAt));
    assertDomainError(() => RoomService.castVote(finished, "s1", null, at(endsAt)), "BATTLE_FINISHED");
  });

  it("rejects an unknown dancer, a malformed dancer id and a room without a battle", () => {
    const room = counting();
    assertDomainError(() => RoomService.castVote(room, "s1", "nobody", DURING), "INVALID_DANCER");
    assertDomainError(() => RoomService.castVote(room, "s1", 42 as unknown as string, DURING), "INVALID_MESSAGE");
    assertDomainError(() => RoomService.castVote(room, "s1", undefined as unknown as string, DURING), "INVALID_MESSAGE");
    const lobby = RoomService.create({ id: "h", displayName: "H" }, "LOBBY1");
    assertDomainError(() => RoomService.castVote(lobby, "h", "a", DURING), "ROOM_NOT_BATTLING");
  });

  it("the room payload carries only the totals, never who voted for whom", () => {
    let room = counting();
    room = RoomService.castVote(room, "s1", "a", DURING);
    room = RoomService.castVote(room, "s2", "a", DURING);
    const dto = toRoomDto(room, DURING);
    assert.equal("votes" in dto.battle!, false);
    assert.deepEqual(dto.battle!.voteCounts, { a: 2, b: 0 });
    assert.deepEqual(dto.battle!.standings.map((s) => [s.dancerId, s.votes, s.score, s.rank]), [
      ["a", 2, 4, 1],
      ["b", 0, 0, 2],
    ]);
    // The stored votes are untouched by serialization.
    assert.deepEqual(room.battle!.votes, { s1: "a", s2: "a" });
  });
});

describe("CastVote use case", () => {
  it("stores the vote and reports the voter's current vote and whether it changed", async () => {
    const rooms = new InMemoryRoomRepository();
    await rooms.insert(counting());
    const castVote = new CastVote(rooms, () => DURING);
    const first = await castVote.execute({ roomCode: "ROOM01", voterId: "s1", dancerId: "b" });
    assert.deepEqual([first.dancerId, first.changed], ["b", true]);
    const again = await castVote.execute({ roomCode: "ROOM01", voterId: "s1", dancerId: "b" });
    assert.deepEqual([again.dancerId, again.changed], ["b", false]);
    assert.equal(again.room.version, first.room.version, "a repeated vote writes nothing");
    const withdrawn = await castVote.execute({ roomCode: "ROOM01", voterId: "s1", dancerId: null });
    assert.deepEqual([withdrawn.dancerId, withdrawn.changed], [null, true]);
  });
});
