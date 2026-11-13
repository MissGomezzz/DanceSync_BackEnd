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
    assert.equal(env.pagehideGraceMs, 3_000);
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
      { PAGEHIDE_GRACE_MS: "-1" },
      { PAGEHIDE_GRACE_MS: "soon" },
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

describe("Authentication configuration (SEG-1)", () => {
  it("fails closed by default: neither Entra ID nor guest tokens are configured", () => {
    const { auth } = loadEnv({});
    assert.equal(auth.entra, null);
    assert.equal(auth.guest, null);
  });

  it("derives the issuer and the key set from the tenant, and the audience from the client id", () => {
    const { auth } = loadEnv({ AZURE_TENANT_ID: " tenant-1 ", AZURE_CLIENT_ID: "client-1" });
    assert.deepEqual(auth.entra, {
      issuer: "https://login.microsoftonline.com/tenant-1/v2.0",
      jwksUri: "https://login.microsoftonline.com/tenant-1/discovery/v2.0/keys",
      audiences: ["client-1"],
    });
    const custom = loadEnv({ AZURE_TENANT_ID: "tenant-1", AZURE_CLIENT_ID: "client-1", AZURE_API_AUDIENCE: "client-1, api://client-1" });
    assert.deepEqual(custom.auth.entra?.audiences, ["client-1", "api://client-1"]);
    // A tenant without an audience cannot validate anything: still not configured.
    assert.equal(loadEnv({ AZURE_TENANT_ID: "tenant-1" }).auth.entra, null);
  });

  it("reads the guest secret and lifetime, and refuses a secret shorter than 32 bytes", () => {
    const secret = "s".repeat(32);
    assert.deepEqual(loadEnv({ GUEST_TOKEN_SECRET: secret }).auth.guest, { secret, ttlSeconds: 7_200 });
    assert.equal(loadEnv({ GUEST_TOKEN_SECRET: secret, GUEST_TOKEN_TTL_SECONDS: "900" }).auth.guest?.ttlSeconds, 900);
    assert.throws(() => loadEnv({ GUEST_TOKEN_SECRET: "too-short" }), /GUEST_TOKEN_SECRET must be at least 32 bytes/);
    assert.throws(() => loadEnv({ GUEST_TOKEN_SECRET: secret, GUEST_TOKEN_TTL_SECONDS: "0" }), /GUEST_TOKEN_TTL_SECONDS/);
  });
});
