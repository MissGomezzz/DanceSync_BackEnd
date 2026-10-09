import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { StartBattle } from "../src/application/usecases/StartBattle.js";
import type { Room } from "../src/domain/model/Room.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { SongSelectionService } from "../src/domain/services/SongSelectionService.js";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { toRoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { allReady, pickSong, readyUp, startable } from "./support/ready.js";
import { ok, record, SocketHarness, waitUntil } from "./support/socketHarness.js";

const T0 = new Date("2026-01-01T00:00:00Z");

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

function lobby(): Room {
  let room = RoomService.create({ id: "a", displayName: "Ana" }, "ROOM01");
  room = RoomService.join(room, { id: "b", displayName: "Beto" });
  room = RoomService.join(room, { id: "c", displayName: "Caro" });
  room = RoomService.join(room, { id: "s", displayName: "Sol" });
  for (const id of ["a", "b", "c"]) room = RoomService.selectRole(room, id, "dancer");
  return RoomService.selectRole(room, "s", "spectator");
}

describe("toRoomDto", () => {
  it("keeps every stored field and adds nothing when there is no selection nor battle", () => {
    const room = lobby();
    const dto = toRoomDto(room, T0);
    assert.deepEqual(dto, room);
  });

  it("adds the time left to type the phrase, never negative", () => {
    const room = SongSelectionService.start(allReady(lobby()), { now: T0, durationMs: 15_000 });
    assert.equal(toRoomDto(room, at(4_000)).songSelection!.challenge.expiresInMs, 11_000);
    assert.equal(toRoomDto(room, at(20_000)).songSelection!.challenge.expiresInMs, 0);
    assert.equal(toRoomDto(room, at(4_000)).songSelection!.challenge.phrase, room.songSelection!.challenge.phrase);
  });

  it("adds startsInMs: positive during the countdown, negative (elapsed) once dancing began", () => {
    const room = RoomService.startBattle(startable(lobby()), undefined, { now: T0, countdownMs: 5_000 });
    assert.equal(toRoomDto(room, at(1_000)).battle!.startsInMs, 4_000);
    assert.equal(toRoomDto(room, at(8_000)).battle!.startsInMs, -3_000);
  });

  it("keeps the roster snapshotted at the start, names included, after a dancer leaves", () => {
    let room = RoomService.startBattle(startable(lobby()), undefined, { now: T0 });
    room = RoomService.leave(room, "c");
    const dto = toRoomDto(room, at(1_000));
    assert.deepEqual(dto.battle!.dancerIds, ["a", "b"]);
    assert.deepEqual(dto.battle!.roster, [
      { id: "a", displayName: "Ana" },
      { id: "b", displayName: "Beto" },
      { id: "c", displayName: "Caro" },
    ]);
  });
});

describe("Room payloads over Socket.IO carry the relative times", () => {
  const harness = new SocketHarness();
  before(() => harness.start({ extend: (rooms) => ({ startBattle: new StartBattle(rooms, { countdownMs: 5_000 }) }) }));
  after(() => harness.stop());

  it("battle:started, room:updated and the ack all include startsInMs and the roster", async () => {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const host = await harness.client();
    const d2 = await harness.client();
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await ok(d2, "room:join", { roomCode: code, playerId: "d2", displayName: "Dos" });
    await ok(host, "role:select", { roomCode: code, playerId: "host", role: "dancer" });
    await ok(d2, "role:select", { roomCode: code, playerId: "d2", role: "dancer" });
    await readyUp(code, { host, d2 });
    await pickSong(harness.rooms, code);
    const started = record<RoomDto>(d2, "battle:started");
    const updated = record<RoomDto>(d2, "room:updated");

    const acked = await ok<RoomDto>(host, "battle:start", { roomCode: code, requesterId: "host" });
    await waitUntil(() => started.length === 1 && updated.some((r) => r.status === "battling"), "battle events");

    for (const room of [acked, started[0], updated.find((r) => r.status === "battling")!]) {
      assert.ok(room.battle!.startsInMs > 0 && room.battle!.startsInMs <= 5_000, `startsInMs ${room.battle!.startsInMs}`);
      assert.deepEqual(room.battle!.roster, [
        { id: "host", displayName: "Host" },
        { id: "d2", displayName: "Dos" },
      ]);
    }
  });
});
