import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadEnv } from "../src/config/env.js";
import type { Room } from "../src/domain/model/Room.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { startable } from "./support/ready.js";

describe("Configuration", () => {
  it("uses the documented defaults when nothing is set", () => {
    const env = loadEnv({});
    assert.equal(env.battleStartCountdownMs, 5_000);
    assert.equal(env.wordBonusPoints, 1);
    assert.equal(env.votePoints, 2);
    assert.equal(env.disconnectGraceMs, 15_000);
    assert.equal("ratingGraceMs" in env, false, "the rating grace period is gone");
  });

  it("accepts valid overrides", () => {
    const env = loadEnv({
      BATTLE_START_COUNTDOWN_MS: "0",
      WORD_BONUS_POINTS: "3",
      VOTE_POINTS: "5",
      DISCONNECT_GRACE_MS: " 2500 ",
    });
    assert.equal(env.votePoints, 5);
    assert.equal(env.battleStartCountdownMs, 0);
    assert.equal(env.wordBonusPoints, 3);
    assert.equal(env.disconnectGraceMs, 2_500);
  });

  it("refuses to start with a value that is not a number, negative, or not whole where required", () => {
    const invalid: Record<string, string>[] = [
      { BATTLE_START_COUNTDOWN_MS: "abc" },
      { BATTLE_START_COUNTDOWN_MS: "-1" },
      { DISCONNECT_GRACE_MS: "-5" },
      { SONG_CHALLENGE_MS: "0" },
      { WORD_BONUS_POINTS: "0" },
      { WORD_BONUS_POINTS: "1.5" },
      { VOTE_POINTS: "0" },
      { VOTE_POINTS: "-2" },
      { VOTE_POINTS: "2.5" },
      { VOTE_POINTS: "two" },
      { WORD_RACE_ROUNDS: "2.5" },
      { WORD_RACE_WINDOW_MS: "Infinity" },
      { PORT: "http" },
    ];
    for (const source of invalid) {
      assert.throws(() => loadEnv(source), /Environment variable/, JSON.stringify(source));
    }
  });
});

describe("Battle start countdown", () => {
  function lobby(): Room {
    let room = RoomService.create({ id: "a", displayName: "A" }, "ROOM01");
    room = RoomService.join(room, { id: "b", displayName: "B" });
    room = RoomService.selectRole(room, "a", "dancer");
    return startable(RoomService.selectRole(room, "b", "dancer"));
  }

  it("places battle.startedAt the injected countdown after the start command", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const battle = RoomService.startBattle(lobby(), undefined, { now, countdownMs: 5_000 }).battle!;
    assert.equal(battle.startedAt.getTime(), now.getTime() + 5_000);
  });

  it("rejects an invalid countdown instead of building an Invalid Date", () => {
    for (const countdownMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      assert.throws(() => RoomService.startBattle(lobby(), undefined, { countdownMs }), RangeError);
    }
  });
});
