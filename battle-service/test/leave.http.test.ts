import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import type { Socket as ClientSocket } from "socket.io-client";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { pickSong, readyUp } from "./support/ready.js";
import { emit, ok, record, SocketHarness, waitUntil } from "./support/socketHarness.js";

const harness = new SocketHarness();
before(() => harness.start());
after(() => harness.stop());

function leave(code: string, body: string, contentType = "application/json"): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/rooms/${code}/leave`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

/** host (the host) and guest dancers, fan spectator, each bound to its own socket. */
async function room() {
  const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
  const sockets: Record<string, ClientSocket> = {};
  for (const [id, role] of [
    ["host", "dancer"],
    ["guest", "dancer"],
    ["fan", "spectator"],
  ] as const) {
    sockets[id] = await harness.client();
    await ok(sockets[id], "room:join", { roomCode: code, playerId: id, displayName: id });
    await ok(sockets[id], "role:select", { roomCode: code, playerId: id, role });
  }
  return { code, sockets };
}

describe("POST /api/rooms/:code/leave (HU 22)", () => {
  it("answers 204 and runs the room:leave flow: seat released, host handed over, broadcast, sockets unbound", async () => {
    const { code, sockets } = await room();
    const guestUpdates = record<RoomDto>(sockets.guest, "room:updated");
    const hostUpdates = record<RoomDto>(sockets.host, "room:updated");

    const response = await leave(code.toLowerCase(), JSON.stringify({ playerId: "host" }));
    assert.equal(response.status, 204);

    const stored = await harness.storedRoom(code);
    assert.deepEqual(stored.players.map((p) => p.id), ["guest", "fan"]);
    assert.equal(stored.hostId, "guest");
    await waitUntil(() => guestUpdates.some((r) => r.hostId === "guest"), "room:updated to the others");

    // The leaver's socket was unbound like a kicked one: no events, no actions.
    await sleep(30);
    assert.equal(hostUpdates.length, 0, "the leaver still receives the room's events");
    const response2 = await emit(sockets.host, "chat:message", { roomCode: code, senderId: "host", content: "hi" });
    assert.equal(!response2.ok && response2.error.code, "PLAYER_NOT_IN_ROOM");
  });

  it("accepts the text/plain body navigator.sendBeacon sends", async () => {
    const { code } = await room();
    const response = await leave(code, JSON.stringify({ playerId: "fan" }), "text/plain;charset=UTF-8");
    assert.equal(response.status, 204);
    assert.deepEqual((await harness.storedRoom(code)).players.map((p) => p.id), ["host", "guest"]);
  });

  it("settles a running battle: a dancer leaving over HTTP finishes it with battle:finished", async () => {
    const { code, sockets } = await room();
    await readyUp(code, sockets);
    await pickSong(harness.rooms, code);
    const finished = record<RoomDto>(sockets.fan, "battle:finished");
    await ok(sockets.host, "battle:start", { roomCode: code, requesterId: "host" });
    await ok(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "guest" });

    const response = await leave(code, JSON.stringify({ playerId: "host" }), "text/plain");
    assert.equal(response.status, 204);
    await waitUntil(() => finished.length === 1, "battle:finished after the HTTP leave");
    assert.equal(finished[0].battle!.endReason, "not-enough-dancers");
    assert.equal(finished[0].battle!.result!.winnerId, "guest");
    assert.equal(harness.roomTimers().pending(code), 0, "a battle timer leaked");
  });

  it("validates the request: 400 for a bad body or player id, 404 for an unknown room, 403 for a non-member", async () => {
    const { code } = await room();
    const cases: [string, string, string, number][] = [
      [code, "{not json", "text/plain", 400],
      [code, "{not json", "application/json", 400],
      [code, JSON.stringify({}), "application/json", 400],
      [code, JSON.stringify({ playerId: 5 }), "text/plain", 400],
      [code, JSON.stringify({ playerId: " host" }), "application/json", 400],
      [code, JSON.stringify({ playerId: "x".repeat(65) }), "application/json", 400],
      [code, "", "application/octet-stream", 400],
      ["NOROOM", JSON.stringify({ playerId: "host" }), "application/json", 404],
      [code, JSON.stringify({ playerId: "stranger" }), "application/json", 403],
    ];
    for (const [roomCode, body, type, status] of cases) {
      const response = await leave(roomCode, body, type);
      assert.equal(response.status, status, `${type} ${body}`);
      assert.ok(typeof ((await response.json()) as { error: string }).error === "string");
    }
    assert.equal((await harness.storedRoom(code)).players.length, 3, "a rejected request changed the room");
  });

  it("the last player leaving over HTTP deletes the room", async () => {
    const { code } = await harness.createRoom.execute({ hostId: "solo", displayName: "Solo" });
    assert.equal((await leave(code, JSON.stringify({ playerId: "solo" }))).status, 204);
    assert.equal(await harness.rooms.findByCode(code), undefined);
    assert.equal((await leave(code, JSON.stringify({ playerId: "solo" }))).status, 404);
  });
});

describe('POST /api/rooms/:code/leave with reason "pagehide" (beacon on reload or tab close)', () => {
  const PAGEHIDE_GRACE_MS = 300;
  // Much longer than the pagehide grace, so a release can only come from the pagehide timer.
  const DISCONNECT_GRACE_MS = 5_000;
  const beacons = new SocketHarness();
  before(() => beacons.start({ pagehideGraceMs: PAGEHIDE_GRACE_MS, disconnectGraceMs: DISCONNECT_GRACE_MS }));
  after(() => beacons.stop());

  function beacon(code: string, playerId: string, reason: unknown = "pagehide"): Promise<Response> {
    return fetch(`${beacons.baseUrl}/api/rooms/${code}/leave`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ playerId, reason }),
    });
  }

  /** Running battle: host and guest dance, fan watches. */
  async function battling() {
    const { code } = await beacons.createRoom.execute({ hostId: "host", displayName: "Host" });
    const sockets: Record<string, ClientSocket> = {};
    for (const [id, role] of [
      ["host", "dancer"],
      ["guest", "dancer"],
      ["fan", "spectator"],
    ] as const) {
      sockets[id] = await beacons.client();
      await ok(sockets[id], "room:join", { roomCode: code, playerId: id, displayName: id });
      await ok(sockets[id], "role:select", { roomCode: code, playerId: id, role });
    }
    await readyUp(code, sockets);
    await pickSong(beacons.rooms, code);
    const finished = record<RoomDto>(sockets.fan, "battle:finished");
    await ok(sockets.host, "battle:start", { roomCode: code, requesterId: "host" });
    return { code, sockets, finished };
  }

  it("reload: the page rejoins within the grace and keeps its seat, the host role and its place in the battle", async () => {
    const { code, sockets, finished } = await battling();
    const response = await beacon(code, "host");
    assert.equal(response.status, 202, "a pagehide leave is only scheduled");
    // The page unloads (its socket drops) and the reloaded page joins again.
    sockets.host.disconnect();
    const reloaded = await beacons.client();
    await ok(reloaded, "room:join", { roomCode: code, playerId: "host", displayName: "host" });

    await sleep(PAGEHIDE_GRACE_MS + 200);
    const stored = await beacons.storedRoom(code);
    assert.deepEqual(stored.players.map((p) => p.id), ["host", "guest", "fan"]);
    assert.equal(stored.hostId, "host");
    assert.equal(stored.status, "battling");
    assert.deepEqual(stored.battle!.dancerIds, ["host", "guest"]);
    assert.equal(finished.length, 0);
    // Close the battle so no timer outlives the test.
    await ok(sockets.guest, "room:leave", { roomCode: code, playerId: "guest" });
  });

  it("tab close: nobody rejoins, so the seat is released after the short grace and the battle settles", async () => {
    const { code, sockets, finished } = await battling();
    const fanUpdates = record<RoomDto>(sockets.fan, "room:updated");
    assert.equal((await beacon(code, "host")).status, 202);
    sockets.host.disconnect(); // the closing tab's socket drops right after the beacon

    // Not released at once...
    await sleep(PAGEHIDE_GRACE_MS / 3);
    assert.equal((await beacons.storedRoom(code)).players.length, 3, "released before the grace ran out");
    // ...but well before the disconnect grace: the later socket drop did not postpone it.
    await waitUntil(() => finished.length === 1, "battle:finished after the pagehide grace", DISCONNECT_GRACE_MS - 1_000);
    const stored = await beacons.storedRoom(code);
    assert.deepEqual(stored.players.map((p) => p.id), ["guest", "fan"]);
    assert.equal(stored.hostId, "guest", "the host role is handed over");
    assert.equal(finished[0].battle!.endReason, "not-enough-dancers");
    assert.ok(fanUpdates.some((r) => r.hostId === "guest"));
    assert.equal(beacons.roomTimers().pending(code), 0, "a battle timer leaked");
  });

  it("a page hidden while its socket stays connected (back/forward cache) keeps the seat", async () => {
    const { code } = await beacons.createRoom.execute({ hostId: "solo", displayName: "Solo" });
    const socket = await beacons.client();
    await ok(socket, "room:join", { roomCode: code, playerId: "solo", displayName: "Solo" });
    assert.equal((await beacon(code, "solo")).status, 202);
    await sleep(PAGEHIDE_GRACE_MS + 200);
    assert.deepEqual((await beacons.storedRoom(code)).players.map((p) => p.id), ["solo"]);
  });

  it('reason "explicit" (or none) still leaves at once; an unknown reason, room or player is refused', async () => {
    const { code } = await beacons.createRoom.execute({ hostId: "a", displayName: "A" });
    await beacons.rooms.update(code, (r) => ({ ...r, players: [...r.players, { id: "b", displayName: "B", role: "undecided", ready: false }] }));
    assert.equal((await beacon(code, "x", "reload")).status, 400);
    assert.equal((await beacon(code, "a", null)).status, 400);
    assert.equal((await beacon("NOROOM", "a")).status, 404);
    assert.equal((await beacon(code, "stranger")).status, 403);
    assert.equal((await beacon(code, "b", "explicit")).status, 204);
    assert.deepEqual((await beacons.storedRoom(code)).players.map((p) => p.id), ["a"]);
  });
});
