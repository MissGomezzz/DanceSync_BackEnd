import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import type { Socket as ClientSocket } from "socket.io-client";
import type { Room } from "../src/domain/model/Room.js";
import { emit, ok, record, SocketHarness, waitUntil } from "./support/socketHarness.js";
import { pickSong, readyUp } from "./support/ready.js";

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
  await readyUp(code, sockets);
  await pickSong(harness.rooms, code);
  const finished = record<Room>(sockets[dancers[0]], "battle:finished");
  await ok(sockets[dancers[0]], "battle:start", { roomCode: code, requesterId: dancers[0] });
  return { code, sockets, finished };
}

describe("Room concurrency over Socket.IO", () => {
  it("back-to-back vote changes from the same socket end on the last one", async () => {
    const { code, sockets } = await battle(["host", "d2"], ["fan"]);
    const acks = await Promise.all([
      emit<{ dancerId: string | null }>(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "host" }),
      emit<{ dancerId: string | null }>(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "d2" }),
      emit<{ dancerId: string | null }>(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "host" }),
    ]);
    assert.ok(acks.every((a) => a.ok));
    // Socket.IO runs one socket's events in order, so the last one sent is the last one stored.
    assert.deepEqual((await harness.storedRoom(code)).battle!.votes, { fan: "host" });
  });

  it("a full room voting at once (5 spectators, bursts per socket) keeps every spectator's last vote", async () => {
    const fans = ["f1", "f2", "f3", "f4", "f5"];
    const { code, sockets, finished } = await battle(["host", "d2"], fans);
    const acks = await Promise.all(
      fans.flatMap((fan, i) =>
        [i % 2 === 0 ? "host" : "d2", i % 2 === 0 ? "d2" : "host"].map((dancerId) =>
          emit(sockets[fan], "vote:cast", { roomCode: code, voterId: fan, dancerId }),
        ),
      ),
    );
    assert.ok(acks.every((a) => a.ok));
    const stored = await harness.storedRoom(code);
    assert.deepEqual(stored.battle!.votes, { f1: "d2", f2: "host", f3: "d2", f4: "host", f5: "d2" });
    assert.equal(stored.status, "battling", "votes never finish a battle; the song end does");
    assert.equal(finished.length, 0);
  });

  it("role:select followed at once by battle:start from the same socket starts with the new role", async () => {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const host = await harness.client();
    const guest = await harness.client();
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await ok(guest, "room:join", { roomCode: code, playerId: "guest", displayName: "Guest" });
    await ok(guest, "role:select", { roomCode: code, playerId: "guest", role: "dancer" });
    await readyUp(code, { host, guest });
    await pickSong(harness.rooms, code);

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
