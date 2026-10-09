import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { StartBattle } from "../src/application/usecases/StartBattle.js";
import { SONG_CATALOG } from "../src/domain/catalog/songs.js";
import type { Room } from "../src/domain/model/Room.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { toRoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { readyUp, startable } from "./support/ready.js";
import { ok, record, SocketHarness, waitUntil } from "./support/socketHarness.js";

const T0 = new Date("2026-01-01T00:00:00Z");
const COUNTDOWN_MS = 5_000;
const GRACE_MS = 30_000;
const SONG_MS = SONG_CATALOG[0].durationSeconds * 1000;
const ENDS_AT = COUNTDOWN_MS + SONG_MS + GRACE_MS;

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

function battle(dancers: string[], spectators: string[]): Room {
  const [hostId, ...others] = [...dancers, ...spectators];
  let room = RoomService.create({ id: hostId, displayName: hostId.toUpperCase() }, "ROOM01");
  for (const id of others) room = RoomService.join(room, { id, displayName: id.toUpperCase() });
  for (const id of dancers) room = RoomService.selectRole(room, id, "dancer");
  for (const id of spectators) room = RoomService.selectRole(room, id, "spectator");
  return RoomService.startBattle(startable(room), undefined, {
    now: T0,
    countdownMs: COUNTDOWN_MS,
    ratingGraceMs: GRACE_MS,
  });
}

describe("Automatic battle end (domain)", () => {
  it("ends at the song clip end plus the rating grace period", () => {
    const room = battle(["a", "b"], ["s"]);
    assert.equal(room.battle!.endsAt.getTime(), at(ENDS_AT).getTime());
    assert.equal(toRoomDto(room, at(COUNTDOWN_MS)).battle!.endsInMs, SONG_MS + GRACE_MS);
  });

  it("does nothing before endsAt", () => {
    const room = battle(["a", "b"], ["s"]);
    assert.equal(RoomService.finishAtDeadline(room, at(ENDS_AT - 1)), room);
  });

  it("with nothing collected (no spectators) finishes without a result", () => {
    const room = RoomService.finishAtDeadline(battle(["a", "b"], []), at(ENDS_AT));
    assert.equal(room.status, "finished");
    assert.equal(room.battle!.result, null);
    assert.equal(room.battle!.finishedAt!.getTime(), at(ENDS_AT).getTime());
    assert.equal(toRoomDto(room, at(ENDS_AT)).battle!.endsInMs, null);
  });

  it("finishes with the ratings collected so far, over the remaining dancers", () => {
    let room = battle(["a", "b", "c"], ["s1", "s2"]);
    room = RoomService.rate(room, { raterId: "s1", dancerId: "a", score: 2 }, at(COUNTDOWN_MS + 1));
    room = RoomService.rate(room, { raterId: "s1", dancerId: "c", score: 5 }, at(COUNTDOWN_MS + 2));
    room = RoomService.leave(room, "c", at(COUNTDOWN_MS + 3));
    room = RoomService.finishAtDeadline(room, at(ENDS_AT));
    assert.equal(room.status, "finished");
    assert.deepEqual(room.battle!.result, { scores: { a: 2, b: 0 }, winnerId: "a" });
  });

  it("counts a word bonus as something collected", () => {
    const room = RoomService.finishAtDeadline(RoomService.awardWordBonus(battle(["a", "b"], []), "b", 1), at(ENDS_AT));
    assert.deepEqual(room.battle!.result, { scores: { a: 0, b: 1 }, winnerId: "b" });
  });

  it("is a no-op on a battle already finished", () => {
    const finished = RoomService.finishAtDeadline(battle(["a", "b"], []), at(ENDS_AT));
    assert.equal(RoomService.finishAtDeadline(finished, at(ENDS_AT + 1)), finished);
  });
});

describe("Automatic battle end over Socket.IO", () => {
  // Long enough for a rating or a leave to land before the deadline on a loaded machine.
  const SOCKET_GRACE_MS = 800;
  const harness = new SocketHarness();
  before(() =>
    harness.start({
      extend: (rooms) => ({ startBattle: new StartBattle(rooms, { ratingGraceMs: SOCKET_GRACE_MS }) }),
    }),
  );
  after(() => harness.stop());

  /** Battle on a zero-length clip, so it ends SOCKET_GRACE_MS after the start. */
  async function shortBattle(spectators: string[]) {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const sockets: Record<string, Awaited<ReturnType<typeof harness.client>>> = {};
    for (const id of ["host", "d2", ...spectators]) {
      sockets[id] = await harness.client();
      await ok(sockets[id], "room:join", { roomCode: code, playerId: id, displayName: id });
      const role = spectators.includes(id) ? "spectator" : "dancer";
      await ok(sockets[id], "role:select", { roomCode: code, playerId: id, role });
    }
    await readyUp(code, sockets);
    await harness.rooms.update(code, (room) => ({ ...room, selectedSong: { ...SONG_CATALOG[0], durationSeconds: 0 } }));
    const finished = record<RoomDto>(sockets.host, "battle:finished");
    const started = await ok<RoomDto>(sockets.host, "battle:start", { roomCode: code, requesterId: "host" });
    assert.ok(started.battle!.endsInMs! > 0 && started.battle!.endsInMs! <= SOCKET_GRACE_MS);
    return { code, sockets, finished };
  }

  it("a battle without spectators finishes on its own, without a result", async () => {
    const { code, finished } = await shortBattle([]);
    await waitUntil(() => finished.length === 1, "battle:finished at the deadline");
    assert.equal(finished[0].status, "finished");
    assert.equal(finished[0].battle!.result, null);
    assert.equal(finished[0].battle!.endsInMs, null);
    assert.equal(harness.roomTimers().pending(code), 0, "a battle timer leaked");
  });

  it("a battle whose last spectator left finishes on its own", async () => {
    const { code, sockets, finished } = await shortBattle(["fan"]);
    const left = await ok<RoomDto>(sockets.fan, "room:leave", { roomCode: code, playerId: "fan" });
    assert.equal(left.status, "battling", "the battle goes on without spectators");
    await waitUntil(() => finished.length === 1, "battle:finished at the deadline");
    assert.equal(finished[0].battle!.result, null);
  });

  it("finishes with the ratings collected so far when some spectators never rate", async () => {
    const { code, sockets, finished } = await shortBattle(["fan", "lazy"]);
    await ok(sockets.fan, "rating:submit", { roomCode: code, raterId: "fan", dancerId: "d2", score: 4 });
    await waitUntil(() => finished.length === 1, "battle:finished at the deadline");
    assert.deepEqual(finished[0].battle!.result, { scores: { host: 0, d2: 4 }, winnerId: "d2" });
    assert.equal(harness.roomTimers().pending(code), 0);
  });

  it("a battle finished by the last rating stops its deadline timer", async () => {
    const { code, sockets, finished } = await shortBattle(["fan"]);
    await ok(sockets.fan, "rating:submit", { roomCode: code, raterId: "fan", dancerId: "host", score: 1 });
    await ok(sockets.fan, "rating:submit", { roomCode: code, raterId: "fan", dancerId: "d2", score: 2 });
    await waitUntil(() => finished.length === 1, "battle:finished by the last rating");
    assert.equal(harness.roomTimers().has(code, "battle-end"), false);
  });
});
