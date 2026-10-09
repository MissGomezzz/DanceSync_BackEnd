import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { DomainError } from "../src/domain/errors/DomainError.js";
import type { Room } from "../src/domain/model/Room.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { SongSelectionService } from "../src/domain/services/SongSelectionService.js";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { allReady, pickSong, readyUp } from "./support/ready.js";
import { emit, ok, record, rejected, SocketHarness, waitUntil } from "./support/socketHarness.js";

function assertDomainError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code);
}

function lobby(): Room {
  let room = RoomService.create({ id: "host", displayName: "Host" }, "ROOM01");
  for (const id of ["a", "b", "idle"]) room = RoomService.join(room, { id, displayName: id.toUpperCase() });
  return room;
}

describe("RoomService.kick", () => {
  it("removes the player from the lobby", () => {
    const room = RoomService.kick(lobby(), "host", "idle");
    assert.deepEqual(room.players.map((p) => p.id), ["host", "a", "b"]);
  });

  it("enforces host only, lobby only, not yourself, and a player of the room", () => {
    assertDomainError(() => RoomService.kick(lobby(), "a", "idle"), "NOT_HOST");
    assertDomainError(() => RoomService.kick(lobby(), "host", "host"), "INVALID_PLAYER");
    assertDomainError(() => RoomService.kick(lobby(), "host", 7 as unknown as string), "INVALID_PLAYER");
    assertDomainError(() => RoomService.kick(lobby(), "host", "nobody"), "PLAYER_NOT_IN_ROOM");
    let battling = lobby();
    battling = RoomService.selectRole(RoomService.selectRole(battling, "a", "dancer"), "b", "dancer");
    battling = RoomService.startBattle({ ...allReady(battling), selectedSong: { id: "s", title: "S", artist: "A", durationSeconds: 90, youtubeId: "x" } });
    assertDomainError(() => RoomService.kick(battling, "host", "idle"), "ROOM_NOT_WAITING");
  });

  it("kicking the song chooser passes the turn on, like any departure", () => {
    let room = RoomService.selectRole(RoomService.selectRole(lobby(), "a", "dancer"), "b", "dancer");
    room = SongSelectionService.start(allReady(room), { phrases: ["ya"] });
    room = SongSelectionService.submit(room, "a", "ya").room;
    const kicked = RoomService.kick(room, "host", "a");
    assert.equal(kicked.songSelection!.chooserId, "b");
    assert.equal(kicked.songSelection!.chooserReason, "chooser-left");
  });
});

describe("player:kick over Socket.IO", () => {
  const GRACE_MS = 500;
  const harness = new SocketHarness();
  before(() => harness.start({ disconnectGraceMs: GRACE_MS }));
  after(() => harness.stop());

  async function room() {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const host = await harness.client();
    const guest = await harness.client();
    const idle = await harness.client();
    const idleTab2 = await harness.client();
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await ok(guest, "room:join", { roomCode: code, playerId: "guest", displayName: "Guest" });
    await ok(idle, "room:join", { roomCode: code, playerId: "idle", displayName: "Idle" });
    await ok(idleTab2, "room:join", { roomCode: code, playerId: "idle", displayName: "Idle" });
    return { code, host, guest, idle, idleTab2 };
  }

  it("the host kicks an idle player: every tab of theirs is told and cut off, the room is updated", async () => {
    const { code, host, idle, idleTab2 } = await room();
    const kicked = record<{ roomCode: string }>(idle, "room:kicked");
    const kickedTab2 = record<{ roomCode: string }>(idleTab2, "room:kicked");
    const seenByHost = record<RoomDto>(host, "room:updated");
    const seenByIdle = record<RoomDto>(idle, "room:updated");

    const updated = await ok<RoomDto>(host, "player:kick", { roomCode: code, requesterId: "host", playerId: "idle" });
    assert.deepEqual(updated.players.map((p) => p.id), ["host", "guest"]);
    await waitUntil(() => kicked.length === 1 && kickedTab2.length === 1, "room:kicked on both tabs");
    assert.deepEqual(kicked[0], { roomCode: code });
    await waitUntil(() => seenByHost.some((r) => r.players.length === 2), "room:updated without the kicked player");
    assert.equal(seenByIdle.length, 0, "the kicked player still receives the room's events");
    assert.deepEqual((await harness.storedRoom(code)).players.map((p) => p.id), ["host", "guest"]);
  });

  it("the kicked player cannot act afterwards", async () => {
    const { code, host, idle } = await room();
    await ok(host, "player:kick", { roomCode: code, requesterId: "host", playerId: "idle" });
    await rejected(idle, "player:ready", { roomCode: code, playerId: "idle", ready: true }, "PLAYER_NOT_IN_ROOM");
    await rejected(idle, "chat:message", { roomCode: code, senderId: "idle", content: "hi" }, "PLAYER_NOT_IN_ROOM");
    await rejected(idle, "room:leave", { roomCode: code, playerId: "idle" }, "PLAYER_NOT_IN_ROOM");
  });

  it("a non-host cannot kick (NOT_HOST) and nothing changes", async () => {
    const { code, guest } = await room();
    await rejected(guest, "player:kick", { roomCode: code, requesterId: "guest", playerId: "idle" }, "NOT_HOST");
    assert.equal((await harness.storedRoom(code)).players.length, 3);
  });

  it("a spoofed requesterId is rejected by the socket identity check", async () => {
    const { code, guest } = await room();
    await rejected(guest, "player:kick", { roomCode: code, requesterId: "host", playerId: "idle" }, "PLAYER_NOT_IN_ROOM");
    assert.equal((await harness.storedRoom(code)).players.length, 3);
  });

  it("the host cannot kick themselves, an unknown player, or with a malformed target", async () => {
    const { code, host } = await room();
    await rejected(host, "player:kick", { roomCode: code, requesterId: "host", playerId: "host" }, "INVALID_PLAYER");
    await rejected(host, "player:kick", { roomCode: code, requesterId: "host", playerId: "ghost" }, "PLAYER_NOT_IN_ROOM");
    await rejected(host, "player:kick", { roomCode: code, requesterId: "host", playerId: { id: "idle" } }, "INVALID_PLAYER");
    const response = await emit(host, "player:kick", null);
    assert.equal(!response.ok && response.error.code, "PLAYER_NOT_IN_ROOM");
  });

  it("nobody can be kicked once the battle is running (ROOM_NOT_WAITING)", async () => {
    const { code, host, guest, idle } = await room();
    await ok(host, "role:select", { roomCode: code, playerId: "host", role: "dancer" });
    await ok(guest, "role:select", { roomCode: code, playerId: "guest", role: "dancer" });
    await readyUp(code, { host, guest, idle });
    await pickSong(harness.rooms, code);
    await ok(host, "battle:start", { roomCode: code, requesterId: "host" });
    await rejected(host, "player:kick", { roomCode: code, requesterId: "host", playerId: "idle" }, "ROOM_NOT_WAITING");
  });

  it("a kicked player whose seat was waiting for a reconnect does not cause a second departure", async () => {
    const { code, host, idle, idleTab2 } = await room();
    idle.disconnect();
    idleTab2.disconnect();
    await ok(host, "player:kick", { roomCode: code, requesterId: "host", playerId: "idle" });
    const seen = record<RoomDto>(host, "room:updated");
    await sleep(GRACE_MS + 150);
    assert.equal(seen.length, 0, "the cancelled grace timer still released the seat");
    assert.deepEqual((await harness.storedRoom(code)).players.map((p) => p.id), ["host", "guest"]);
  });
});
