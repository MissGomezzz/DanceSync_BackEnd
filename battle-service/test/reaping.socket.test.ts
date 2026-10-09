import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { JoinRoom } from "../src/application/usecases/JoinRoom.js";
import { SelectRole } from "../src/application/usecases/SelectRole.js";
import { SetReady } from "../src/application/usecases/SetReady.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { pickSong, readyUp } from "./support/ready.js";
import { ok, record, SocketHarness, waitUntil } from "./support/socketHarness.js";

const GRACE_MS = 100;
// Generous enough for a client to connect and join on a loaded machine.
const CREATED_ROOM_GRACE_MS = 600;

/** Adds a player straight through the use cases: a seat with no socket bound to it. */
async function seatWithoutSocket(harness: SocketHarness, code: string, id: string, role: "dancer" | "spectator") {
  await new JoinRoom(harness.rooms).execute({ roomCode: code, playerId: id, displayName: id });
  await new SelectRole(harness.rooms).execute({ roomCode: code, playerId: id, role });
  await new SetReady(harness.rooms).execute({ roomCode: code, playerId: id, ready: true });
}

describe("Reaping abandoned rooms", () => {
  const harness = new SocketHarness();
  before(() =>
    harness.start({
      disconnectGraceMs: GRACE_MS,
      // The periodic sweep is driven by hand in these tests.
      reaping: { createdRoomGraceMs: CREATED_ROOM_GRACE_MS, sweepIntervalMs: 3_600_000 },
    }),
  );
  after(() => harness.stop());

  it("a room created over HTTP whose host never connects is deleted", async () => {
    const { code, hostId } = await harness.createRoom.execute({ hostId: "ghost", displayName: "Ghost" });
    harness.handlers().watchNewRoom(code, hostId);
    await sleep(CREATED_ROOM_GRACE_MS + 150);
    assert.equal(await harness.rooms.findByCode(code), undefined);
  });

  it("a room whose host connects in time is kept", async () => {
    // Connected beforehand: only the join itself has to beat the deadline, even on a loaded machine.
    const host = await harness.client();
    const { code, hostId } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    harness.handlers().watchNewRoom(code, hostId);
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await sleep(CREATED_ROOM_GRACE_MS + 150);
    assert.deepEqual((await harness.storedRoom(code)).players.map((p) => p.id), ["host"]);
  });

  it("the sweep releases a seat left without a socket for longer than the grace period", async () => {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const host = await harness.client();
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await seatWithoutSocket(harness, code, "stale", "spectator");
    const seen = record<RoomDto>(host, "room:updated");

    await harness.handlers().sweep(); // first sighting: the seat starts its grace period
    assert.equal((await harness.storedRoom(code)).players.length, 2);
    await sleep(GRACE_MS + 30);
    await harness.handlers().sweep();

    assert.deepEqual((await harness.storedRoom(code)).players.map((p) => p.id), ["host"]);
    await waitUntil(() => seen.some((r) => r.players.length === 1), "room:updated without the stale seat");
  });

  it("the sweep deletes rooms left without players", async () => {
    const empty = { ...RoomService.create({ id: "x", displayName: "X" }, "EMPTY1"), players: [] };
    assert.ok(await harness.rooms.insert(empty));
    await harness.handlers().sweep();
    assert.equal(await harness.rooms.findByCode("EMPTY1"), undefined);
  });

  it("a release that leaves one dancer finishes the battle through the normal announcement", async () => {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const host = await harness.client();
    const fan = await harness.client();
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await ok(fan, "room:join", { roomCode: code, playerId: "fan", displayName: "Fan" });
    await ok(host, "role:select", { roomCode: code, playerId: "host", role: "dancer" });
    await ok(fan, "role:select", { roomCode: code, playerId: "fan", role: "spectator" });
    await readyUp(code, { host, fan });
    await seatWithoutSocket(harness, code, "stale", "dancer");
    await pickSong(harness.rooms, code);
    await ok(host, "battle:start", { roomCode: code, requesterId: "host" });
    const finished = record<RoomDto>(fan, "battle:finished");

    await harness.handlers().sweep();
    await sleep(GRACE_MS + 30);
    await harness.handlers().sweep();

    await waitUntil(() => finished.length === 1, "battle:finished after the release");
    assert.equal(finished[0].battle!.endReason, "not-enough-dancers");
    assert.equal(harness.roomTimers().has(code, "battle-end"), false, "the battle deadline timer leaked");
  });
});

describe("Reaping runs on its own", () => {
  const harness = new SocketHarness();
  // The grace leaves the host time to connect before the sweep could take its seat.
  before(() => harness.start({ disconnectGraceMs: 400, reaping: { sweepIntervalMs: 40 } }));
  after(() => harness.stop());

  it("the periodic sweep releases an abandoned seat without any help", async () => {
    const host = await harness.client();
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await seatWithoutSocket(harness, code, "stale", "spectator");
    const seen = record<RoomDto>(host, "room:updated");
    await waitUntil(() => seen.some((r) => r.players.length === 1), "the sweep released the stale seat");
  });
});
