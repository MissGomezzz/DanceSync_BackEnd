import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import type { Room } from "../src/domain/model/Room.js";
import { emit, ok, record, rejected, SocketHarness, waitUntil } from "./support/socketHarness.js";

const GRACE_MS = 400;
const harness = new SocketHarness();

before(() => harness.start({ disconnectGraceMs: GRACE_MS }));
after(() => harness.stop());

async function newRoom(hostId: string): Promise<string> {
  const { code } = await harness.createRoom.execute({ hostId, displayName: hostId });
  return code;
}

async function playerIds(code: string): Promise<string[]> {
  return (await harness.storedRoom(code)).players.map((p) => p.id);
}

describe("Socket binding lifecycle", () => {
  it("joining another room releases the previous seat and its channels", async () => {
    const roomA = await newRoom("hostA");
    const roomB = await newRoom("hostB");
    const hostA = await harness.client();
    const switcher = await harness.client();
    await ok(hostA, "room:join", { roomCode: roomA, playerId: "hostA", displayName: "HostA" });
    await ok(switcher, "room:join", { roomCode: roomA, playerId: "p1", displayName: "P1" });
    const seenByHostA = record<Room>(hostA, "room:updated");

    await ok(switcher, "room:join", { roomCode: roomB, playerId: "p1", displayName: "P1" });
    assert.deepEqual(await playerIds(roomA), ["hostA"], "ghost seat left in the previous room");
    assert.deepEqual(await playerIds(roomB), ["hostB", "p1"]);
    await waitUntil(() => seenByHostA.some((r) => !r.players.some((p) => p.id === "p1")), "room A told p1 left");

    // No more events from room A, and no actions there.
    const received = record<Room>(switcher, "room:updated");
    await ok(hostA, "role:select", { roomCode: roomA, playerId: "hostA", role: "dancer" });
    await sleep(50);
    assert.ok(received.every((r) => r.code === roomB), "still subscribed to the previous room");
    await rejected(switcher, "chat:message", { roomCode: roomA, senderId: "p1", content: "hi" }, "PLAYER_NOT_IN_ROOM");

    // A later disconnect releases the current seat, never the old one twice.
    switcher.disconnect();
    await sleep(GRACE_MS + 100);
    assert.deepEqual(await playerIds(roomB), ["hostB"]);
  });

  it("joining the same room under another identity releases the previous identity", async () => {
    const code = await newRoom("host");
    const host = await harness.client();
    const socket = await harness.client();
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await ok(socket, "room:join", { roomCode: code, playerId: "alias1", displayName: "Alias" });
    const room = await ok<Room>(socket, "room:join", { roomCode: code, playerId: "alias2", displayName: "Alias" });
    assert.deepEqual(room.players.map((p) => p.id), ["host", "alias2"]);
    assert.deepEqual(await playerIds(code), ["host", "alias2"]);
    await rejected(socket, "chat:message", { roomCode: code, senderId: "alias1", content: "hi" }, "PLAYER_NOT_IN_ROOM");
    await ok(socket, "chat:message", { roomCode: code, senderId: "alias2", content: "hi" });
  });

  it("a failed join keeps the previous seat and binding", async () => {
    const roomA = await newRoom("hostA");
    const socket = await harness.client();
    await ok(socket, "room:join", { roomCode: roomA, playerId: "p1", displayName: "P1" });
    await rejected(socket, "room:join", { roomCode: "NOPE00", playerId: "p1", displayName: "P1" }, "ROOM_NOT_FOUND");
    assert.deepEqual(await playerIds(roomA), ["hostA", "p1"]);
    await ok(socket, "chat:message", { roomCode: roomA, senderId: "p1", content: "still here" });
  });

  it("a stale grace timer cannot release a seat renewed by a later reconnect", async () => {
    const code = await newRoom("host");
    const host = await harness.client();
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    const join = { roomCode: code, playerId: "flaky", displayName: "Flaky" };

    const first = await harness.client();
    await ok(first, "room:join", join);
    const t0 = Date.now();
    first.disconnect(); // grace timer #1 due at t0 + GRACE_MS
    const second = await harness.client();
    await ok(second, "room:join", join); // must cancel timer #1
    await sleep(Math.max(0, t0 + GRACE_MS - 100 - Date.now()));
    second.disconnect(); // timer #2 due at about t0 + 2 * GRACE_MS
    // Timer #1 would fire now, while the player is away again.
    await sleep(Math.max(0, t0 + GRACE_MS + 100 - Date.now()));
    assert.ok((await playerIds(code)).includes("flaky"), "the old timer released the renewed seat");
    const third = await harness.client();
    await ok(third, "room:join", join); // cancels timer #2
    await sleep(GRACE_MS + 50);
    assert.ok((await playerIds(code)).includes("flaky"), "a cancelled timer still released the seat");
  });

  it("leaving from one tab unbinds the player's other tabs in that room", async () => {
    const code = await newRoom("host");
    const host = await harness.client();
    const tab1 = await harness.client();
    const tab2 = await harness.client();
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await ok(tab1, "room:join", { roomCode: code, playerId: "p1", displayName: "P1" });
    await ok(tab2, "room:join", { roomCode: code, playerId: "p1", displayName: "P1" });

    await ok(tab1, "room:leave", { roomCode: code, playerId: "p1" });
    assert.deepEqual(await playerIds(code), ["host"]);
    await rejected(tab2, "chat:message", { roomCode: code, senderId: "p1", content: "ghost" }, "PLAYER_NOT_IN_ROOM");
    await rejected(tab2, "webrtc:ready", { roomCode: code, playerId: "p1" }, "PLAYER_NOT_IN_ROOM");
    const received = record<Room>(tab2, "room:updated");
    await ok(host, "role:select", { roomCode: code, playerId: "host", role: "dancer" });
    await sleep(50);
    assert.equal(received.length, 0, "the other tab still receives the room's events");

    // The tab can join again explicitly.
    const back = await emit<Room>(tab2, "room:join", { roomCode: code, playerId: "p1", displayName: "P1" });
    assert.ok(back.ok);
  });
});
