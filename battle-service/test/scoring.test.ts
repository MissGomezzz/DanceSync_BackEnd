import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Battle } from "../src/domain/model/Battle.js";
import type { Room } from "../src/domain/model/Room.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { ScoringService } from "../src/domain/services/ScoringService.js";
import { toRoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { assertDomainError, at, battleRoom } from "./support/battles.js";

const DURING = at(1_000);

/** A battle of the given dancers with explicit votes and words won. */
function scored(dancers: string[], votes: Record<string, string>, wordsWon: Record<string, number> = {}): Battle {
  const room = battleRoom(dancers, []);
  return { ...room.battle!, votes, wordsWon: { ...room.battle!.wordsWon, ...wordsWon } };
}

function ranks(battle: Battle): [string, number, number][] {
  return ScoringService.standings(battle).map((s) => [s.dancerId, s.score, s.rank]);
}

describe("ScoringService: score = VOTE_POINTS x votes + WORD_BONUS_POINTS x wordsWon", () => {
  it("uses 2 points per vote and 1 per word by default", () => {
    const battle = scored(["a", "b"], { s1: "a", s2: "a", s3: "b" }, { b: 3 });
    assert.deepEqual(ScoringService.standings(battle), [
      { dancerId: "b", displayName: "B", votes: 1, wordsWon: 3, score: 5, rank: 1 },
      { dancerId: "a", displayName: "A", votes: 2, wordsWon: 0, score: 4, rank: 2 },
    ]);
  });

  it("applies the configured points", () => {
    const battle = scored(["a", "b"], { s1: "a" }, { b: 1 });
    const standings = ScoringService.standings(battle, { votePoints: 5, wordBonusPoints: 3 });
    assert.deepEqual(standings.map((s) => [s.dancerId, s.score]), [["a", 5], ["b", 3]]);
  });

  it("snapshots the configured points into the battle when it starts", () => {
    const room = battleRoom(["a", "b"], ["s"], { scoring: { votePoints: 10, wordBonusPoints: 4 } });
    assert.deepEqual(room.battle!.scoring, { votePoints: 10, wordBonusPoints: 4 });
    const voted = RoomService.castVote(room, "s", "b", DURING);
    assert.equal(ScoringService.standings(voted.battle!)[0].score, 10);
    assert.throws(() => battleRoom(["a", "b"], [], { scoring: { votePoints: 1.5, wordBonusPoints: 1 } }), RangeError);
  });

  it("counts votes per remaining dancer and ignores votes for anyone else", () => {
    const battle = scored(["a", "b"], { s1: "a", s2: "ghost" });
    assert.deepEqual(ScoringService.voteCounts(battle), { a: 1, b: 0 });
  });
});

describe("ScoringService: competition ranking with ties", () => {
  it("ranks 1, 2, 3 without ties", () => {
    const battle = scored(["a", "b", "c"], { s1: "c", s2: "c", s3: "b" });
    assert.deepEqual(ranks(battle), [["c", 4, 1], ["b", 2, 2], ["a", 0, 3]]);
  });

  it("shares a rank between equal scores and skips the next one (1, 1, 3)", () => {
    const battle = scored(["a", "b", "c"], { s1: "a", s2: "b" });
    assert.deepEqual(ranks(battle), [["a", 2, 1], ["b", 2, 1], ["c", 0, 3]]);
  });

  it("ties further down keep the leader alone (1, 2, 2, 4)", () => {
    const battle = scored(["a", "b", "c", "d"], { s1: "d", s2: "d", s3: "b", s4: "c" });
    assert.deepEqual(ranks(battle), [["d", 4, 1], ["b", 2, 2], ["c", 2, 2], ["a", 0, 4]]);
  });

  it("a vote and two words are worth the same: a tie across sources", () => {
    const battle = scored(["a", "b"], { s1: "a" }, { b: 2 });
    assert.deepEqual(ranks(battle), [["a", 2, 1], ["b", 2, 1]]);
  });

  it("the result names the only leader, or nobody on a draw at the top", () => {
    assert.equal(ScoringService.result(scored(["a", "b"], { s1: "b" })).winnerId, "b");
    assert.equal(ScoringService.result(scored(["a", "b"], { s1: "a", s2: "b" })).winnerId, null);
    assert.equal(ScoringService.result(scored(["a", "b"], {})).winnerId, null, "nothing collected is a draw");
  });
});

describe("Word race wins in the battle score", () => {
  it("a battle starts with no word won by anyone, and each win counts one", () => {
    let room: Room = battleRoom(["a", "b"], ["s"]);
    assert.deepEqual(room.battle!.wordsWon, { a: 0, b: 0 });
    room = RoomService.awardWordBonus(room, "a");
    room = RoomService.awardWordBonus(room, "a");
    assert.deepEqual(room.battle!.wordsWon, { a: 2, b: 0 });
    assert.deepEqual(toRoomDto(room, DURING).battle!.standings.map((s) => [s.dancerId, s.wordsWon, s.score]), [
      ["a", 2, 2],
      ["b", 0, 0],
    ]);
  });

  it("only a dancer still in a running battle can win a word", () => {
    const room = battleRoom(["a", "b", "c"], ["s"]);
    assertDomainError(() => RoomService.awardWordBonus(room, "s"), "INVALID_DANCER");
    assertDomainError(() => RoomService.awardWordBonus(RoomService.leave(room, "c", DURING), "c"), "INVALID_DANCER");
    const finished = RoomService.finishAtDeadline(room, room.battle!.endsAt);
    assertDomainError(() => RoomService.awardWordBonus(finished, "a"), "ROOM_NOT_BATTLING");
  });
});
