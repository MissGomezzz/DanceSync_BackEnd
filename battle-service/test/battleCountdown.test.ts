import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { StartBattle } from "../src/application/usecases/StartBattle.js";
import { DomainError } from "../src/domain/errors/DomainError.js";
import type { Room } from "../src/domain/model/Room.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { pickSong, readyUp, startable } from "./support/ready.js";
import { ok, rejected, SocketHarness } from "./support/socketHarness.js";

const T0 = new Date("2026-01-01T00:00:00Z");
const COUNTDOWN_MS = 5_000;

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

function counting(): Room {
  let room = RoomService.create({ id: "a", displayName: "A" }, "ROOM01");
  room = RoomService.join(room, { id: "b", displayName: "B" });
  room = RoomService.join(room, { id: "s", displayName: "S" });
  room = RoomService.selectRole(room, "a", "dancer");
  room = RoomService.selectRole(room, "b", "dancer");
  room = RoomService.selectRole(room, "s", "spectator");
  return RoomService.startBattle(startable(room), undefined, { now: T0, countdownMs: COUNTDOWN_MS });
}

describe("Ratings during the start countdown", () => {
  it("are rejected with BATTLE_NOT_STARTED until battle.startedAt", () => {
    const room = counting();
    assert.throws(
      () => RoomService.rate(room, { raterId: "s", dancerId: "a", score: 5 }, at(COUNTDOWN_MS - 1)),
      (error: unknown) => error instanceof DomainError && error.code === "BATTLE_NOT_STARTED",
    );
    const rated = RoomService.rate(room, { raterId: "s", dancerId: "a", score: 5 }, at(COUNTDOWN_MS));
    assert.equal(rated.battle!.ratings.length, 1);
    assert.equal(rated.battle!.ratings[0].submittedAt.getTime(), at(COUNTDOWN_MS).getTime());
  });

  it("cannot finish the battle early: the last rating needed is refused just the same", () => {
    let room = counting();
    room = RoomService.rate(room, { raterId: "s", dancerId: "a", score: 3 }, at(COUNTDOWN_MS));
    assert.equal(RoomService.allRatingsSubmitted(room), false);
    assert.equal(room.status, "battling");
  });
});

describe("Ratings during the start countdown over Socket.IO", () => {
  const harness = new SocketHarness();
  before(() => harness.start({ extend: (rooms) => ({ startBattle: new StartBattle(rooms, { countdownMs: 60_000 }) }) }));
  after(() => harness.stop());

  it("a spectator rating before the dancing begins gets BATTLE_NOT_STARTED and nothing is stored", async () => {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const host = await harness.client();
    const d2 = await harness.client();
    const fan = await harness.client();
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await ok(d2, "room:join", { roomCode: code, playerId: "d2", displayName: "D2" });
    await ok(fan, "room:join", { roomCode: code, playerId: "fan", displayName: "Fan" });
    await ok(host, "role:select", { roomCode: code, playerId: "host", role: "dancer" });
    await ok(d2, "role:select", { roomCode: code, playerId: "d2", role: "dancer" });
    await ok(fan, "role:select", { roomCode: code, playerId: "fan", role: "spectator" });
    await readyUp(code, { host, d2, fan });
    await pickSong(harness.rooms, code);
    await ok(host, "battle:start", { roomCode: code, requesterId: "host" });

    await rejected(fan, "rating:submit", { roomCode: code, raterId: "fan", dancerId: "host", score: 5 }, "BATTLE_NOT_STARTED");
    assert.equal((await harness.storedRoom(code)).battle!.ratings.length, 0);
  });
});
