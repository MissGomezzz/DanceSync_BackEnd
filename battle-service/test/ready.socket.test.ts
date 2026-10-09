import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Room } from "../src/domain/model/Room.js";
import { pickSong, readyUp } from "./support/ready.js";
import { emit, ok, record, rejected, SocketHarness, waitUntil } from "./support/socketHarness.js";

const harness = new SocketHarness();

before(() => harness.start());
after(() => harness.stop());

async function lobby() {
  const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
  const host = await harness.client();
  const guest = await harness.client();
  await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
  await ok(guest, "room:join", { roomCode: code, playerId: "guest", displayName: "Guest" });
  return { code, host, guest };
}

const readyOf = (room: Room, id: string) => room.players.find((p) => p.id === id)?.ready;

describe("player:ready", () => {
  it("players start as not ready", async () => {
    const { code } = await lobby();
    const room = await harness.storedRoom(code);
    assert.deepEqual(room.players.map((p) => p.ready), [false, false]);
  });

  it("marks the player ready and tells every participant in the room", async () => {
    const { code, host, guest } = await lobby();
    const seenByHost = record<Room>(host, "room:updated");

    const room = await ok<Room>(guest, "player:ready", { roomCode: code, playerId: "guest", ready: true });

    assert.equal(readyOf(room, "guest"), true);
    assert.equal(readyOf(room, "host"), false);
    await waitUntil(() => seenByHost.some((r) => readyOf(r, "guest") === true), "the host to see guest ready");
  });

  it("clicking again reverts the state and updates the room", async () => {
    const { code, host, guest } = await lobby();
    await ok(guest, "player:ready", { roomCode: code, playerId: "guest", ready: true });
    const seenByHost = record<Room>(host, "room:updated");

    const room = await ok<Room>(guest, "player:ready", { roomCode: code, playerId: "guest", ready: false });

    assert.equal(readyOf(room, "guest"), false);
    await waitUntil(() => seenByHost.some((r) => readyOf(r, "guest") === false), "the host to see guest not ready");
    assert.equal(readyOf(await harness.storedRoom(code), "guest"), false);
  });

  it("repeating the same state keeps it", async () => {
    const { code, guest } = await lobby();
    await ok(guest, "player:ready", { roomCode: code, playerId: "guest", ready: true });
    const room = await ok<Room>(guest, "player:ready", { roomCode: code, playerId: "guest", ready: true });
    assert.equal(readyOf(room, "guest"), true);
  });

  it("keeps the ready state when the player switches role", async () => {
    const { code, guest } = await lobby();
    await ok(guest, "player:ready", { roomCode: code, playerId: "guest", ready: true });
    const room = await ok<Room>(guest, "role:select", { roomCode: code, playerId: "guest", role: "dancer" });
    assert.equal(readyOf(room, "guest"), true);
  });

  it("rejects a flag that is not a boolean", async () => {
    const { code, guest } = await lobby();
    for (const ready of ["true", 1, null, undefined]) {
      await rejected(guest, "player:ready", { roomCode: code, playerId: "guest", ready }, "INVALID_MESSAGE");
    }
  });

  it("cannot mark someone else as ready", async () => {
    const { code, guest } = await lobby();
    await rejected(guest, "player:ready", { roomCode: code, playerId: "host", ready: true }, "PLAYER_NOT_IN_ROOM");
    assert.equal(readyOf(await harness.storedRoom(code), "host"), false);
  });

  it("cannot change after the battle started", async () => {
    const { code, host, guest } = await lobby();
    await ok(host, "role:select", { roomCode: code, playerId: "host", role: "dancer" });
    await ok(guest, "role:select", { roomCode: code, playerId: "guest", role: "dancer" });
    await readyUp(code, { host, guest });
    await pickSong(harness.rooms, code);
    await ok(host, "battle:start", { roomCode: code, requesterId: "host" });
    const response = await emit(guest, "player:ready", { roomCode: code, playerId: "guest", ready: false });
    assert.equal(response.ok, false);
    assert.equal(!response.ok && response.error.code, "ROOM_NOT_WAITING");
  });
});

describe("starting the battle requires everyone to be ready", () => {
  async function twoDancers() {
    const room = await lobby();
    await ok(room.host, "role:select", { roomCode: room.code, playerId: "host", role: "dancer" });
    await ok(room.guest, "role:select", { roomCode: room.code, playerId: "guest", role: "dancer" });
    return room;
  }

  it("refuses to start while nobody is ready", async () => {
    const { code, host } = await twoDancers();
    await rejected(host, "battle:start", { roomCode: code, requesterId: "host" }, "PLAYERS_NOT_READY");
    assert.equal((await harness.storedRoom(code)).status, "waiting");
  });

  it("refuses to start while one player is still not ready, then starts once they are", async () => {
    const { code, host, guest } = await twoDancers();
    await ok(host, "player:ready", { roomCode: code, playerId: "host", ready: true });
    await rejected(host, "battle:start", { roomCode: code, requesterId: "host" }, "PLAYERS_NOT_READY");

    await ok(guest, "player:ready", { roomCode: code, playerId: "guest", ready: true });
    await pickSong(harness.rooms, code);
    const room = await ok<Room>(host, "battle:start", { roomCode: code, requesterId: "host" });
    assert.equal(room.status, "battling");
  });

  it("cancelling readiness blocks the start again", async () => {
    const { code, host, guest } = await twoDancers();
    await readyUp(code, { host, guest });
    await ok(guest, "player:ready", { roomCode: code, playerId: "guest", ready: false });
    await rejected(host, "battle:start", { roomCode: code, requesterId: "host" }, "PLAYERS_NOT_READY");
  });

  it("an explicit dancer list does not bypass the check", async () => {
    const { code, host } = await twoDancers();
    await rejected(host, "battle:start", { roomCode: code, requesterId: "host", dancerIds: ["host", "guest"] }, "PLAYERS_NOT_READY");
  });
});
