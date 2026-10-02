import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import type { Socket as ClientSocket } from "socket.io-client";
import type { Room } from "../src/domain/model/Room.js";
import { emit, ok, record, SocketHarness, waitUntil } from "./support/socketHarness.js";

/**
 * Socket.IO dispatches the events of one socket through process.nextTick, so
 * frames read in the same TCP chunk run interleaved. These tests fire events
 * back to back (no await in between) and check that no change is lost.
 */
const harness = new SocketHarness();

before(() => harness.start());
after(() => harness.stop());

async function battle(
  dancers: string[],
  spectators: string[],
): Promise<{ code: string; sockets: Record<string, ClientSocket>; finished: Room[] }> {
  const { code } = await harness.createRoom.execute({ hostId: dancers[0], displayName: dancers[0] });
  const sockets: Record<string, ClientSocket> = {};
  for (const id of [...dancers, ...spectators]) {
    sockets[id] = await harness.client();
    await ok(sockets[id], "room:join", { roomCode: code, playerId: id, displayName: id });
    await ok(sockets[id], "role:select", { roomCode: code, playerId: id, role: dancers.includes(id) ? "dancer" : "spectator" });
  }
  const finished = record<Room>(sockets[dancers[0]], "battle:finished");
  await ok(sockets[dancers[0]], "battle:start", { roomCode: code, requesterId: dancers[0] });
  return { code, sockets, finished };
}

describe("Room concurrency over Socket.IO", () => {
  it("two back-to-back ratings from the same socket are both stored and finish the battle", async () => {
    const { code, sockets, finished } = await battle(["host", "d2"], ["fan"]);
    const [first, second] = await Promise.all([
      emit<Room>(sockets.fan, "rating:submit", { roomCode: code, raterId: "fan", dancerId: "host", score: 5 }),
      emit<Room>(sockets.fan, "rating:submit", { roomCode: code, raterId: "fan", dancerId: "d2", score: 3 }),
    ]);
    assert.ok(first.ok && second.ok);
    const stored = await harness.storedRoom(code);
    assert.equal(stored.battle!.ratings.length, 2);
    assert.equal(stored.status, "finished");
    assert.deepEqual(stored.battle!.result, { scores: { host: 5, d2: 3 }, winnerId: "host" });
    await waitUntil(() => finished.length === 1, "battle:finished");
    await sleep(50);
    assert.equal(finished.length, 1, "battle:finished announced more than once");
  });

  it("the last ratings of two spectators sent at the same time finish the battle exactly once", async () => {
    const { code, sockets, finished } = await battle(["host", "d2"], ["fan1", "fan2"]);
    await ok(sockets.fan1, "rating:submit", { roomCode: code, raterId: "fan1", dancerId: "host", score: 4 });
    await ok(sockets.fan2, "rating:submit", { roomCode: code, raterId: "fan2", dancerId: "host", score: 2 });
    await Promise.all([
      ok(sockets.fan1, "rating:submit", { roomCode: code, raterId: "fan1", dancerId: "d2", score: 1 }),
      ok(sockets.fan2, "rating:submit", { roomCode: code, raterId: "fan2", dancerId: "d2", score: 1 }),
    ]);
    const stored = await harness.storedRoom(code);
    assert.equal(stored.battle!.ratings.length, 4);
    assert.deepEqual(stored.battle!.result, { scores: { host: 6, d2: 2 }, winnerId: "host" });
    await waitUntil(() => finished.length === 1, "battle:finished");
    await sleep(50);
    assert.equal(finished.length, 1, "battle:finished announced more than once");
  });

  it("a full room rating all at once (5 spectators x 2 dancers, bursts per socket) loses nothing", async () => {
    const fans = ["f1", "f2", "f3", "f4", "f5"];
    const { code, sockets, finished } = await battle(["host", "d2"], fans);
    const acks = await Promise.all(
      fans.flatMap((fan) =>
        ["host", "d2"].map((dancerId) => emit(sockets[fan], "rating:submit", { roomCode: code, raterId: fan, dancerId, score: 3 })),
      ),
    );
    assert.ok(acks.every((a) => a.ok));
    const stored = await harness.storedRoom(code);
    assert.equal(stored.battle!.ratings.length, 10);
    assert.equal(stored.status, "finished");
    await waitUntil(() => finished.length === 1, "battle:finished");
  });

  it("role:select followed at once by battle:start from the same socket starts with the new role", async () => {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const host = await harness.client();
    const guest = await harness.client();
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await ok(guest, "room:join", { roomCode: code, playerId: "guest", displayName: "Guest" });
    await ok(guest, "role:select", { roomCode: code, playerId: "guest", role: "dancer" });

    const [role, start] = await Promise.all([
      emit<Room>(host, "role:select", { roomCode: code, playerId: "host", role: "dancer" }),
      emit<Room>(host, "battle:start", { roomCode: code, requesterId: "host" }),
    ]);
    assert.ok(role.ok, "role:select failed");
    assert.ok(start.ok, `battle:start failed: ${!start.ok && start.error.code}`);
    const stored = await harness.storedRoom(code);
    assert.equal(stored.status, "battling");
    assert.deepEqual(stored.battle!.dancerIds, ["host", "guest"]);
    assert.equal(stored.players.find((p) => p.id === "host")?.role, "dancer");
  });
});
