import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import type { Socket as ClientSocket } from "socket.io-client";
import { StartBattle } from "../src/application/usecases/StartBattle.js";
import type { VoteMinePayload } from "../src/infrastructure/ws/events.js";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { pickSong, readyUp } from "./support/ready.js";
import { emit, ok, record, rejected, SocketHarness, waitUntil } from "./support/socketHarness.js";

type VoteAck = { dancerId: string | null };

/** Room with dancers host + d2 and the given spectators; every socket records room:updated and vote:mine. */
async function battle(harness: SocketHarness, spectators: string[] = ["fan", "fan2"]) {
  const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
  const sockets: Record<string, ClientSocket> = {};
  const updates: Record<string, RoomDto[]> = {};
  const mine: Record<string, VoteMinePayload[]> = {};
  for (const id of ["host", "d2", ...spectators]) {
    sockets[id] = await harness.client();
    updates[id] = record<RoomDto>(sockets[id], "room:updated");
    mine[id] = record<VoteMinePayload>(sockets[id], "vote:mine");
    await ok(sockets[id], "room:join", { roomCode: code, playerId: id, displayName: id });
    await ok(sockets[id], "role:select", {
      roomCode: code,
      playerId: id,
      role: spectators.includes(id) ? "spectator" : "dancer",
    });
  }
  await readyUp(code, sockets);
  await pickSong(harness.rooms, code);
  const finished = record<RoomDto>(sockets.host, "battle:finished");
  await ok(sockets.host, "battle:start", { roomCode: code, requesterId: "host" });
  return { code, sockets, updates, mine, finished };
}

describe("vote:cast and vote:mine over Socket.IO (HU 20)", () => {
  const harness = new SocketHarness();
  before(() => harness.start());
  after(() => harness.stop());

  it("casting, moving and withdrawing: ack with the vote, totals to everyone, the choice only to the voter", async () => {
    const { code, sockets, updates, mine } = await battle(harness);

    assert.deepEqual(await ok<VoteAck>(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "d2" }), {
      dancerId: "d2",
    });
    await waitUntil(() => updates.host.some((r) => r.battle?.voteCounts.d2 === 1), "the new totals on a dancer's socket");
    const live = updates.host.at(-1)!;
    assert.equal(live.battle!.standings[0].dancerId, "d2");
    assert.equal(live.battle!.standings[0].score, 2);
    assert.equal("votes" in live.battle!, false, "raw votes must never be broadcast");

    await ok(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "host" });
    await ok(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: null });
    await waitUntil(() => mine.fan.length === 3, "vote:mine after each change");
    assert.deepEqual(mine.fan.map((m) => m.dancerId), ["d2", "host", null]);
    assert.ok(mine.fan.every((m) => m.roomCode === code));
    await waitUntil(() => updates.d2.at(-1)?.battle?.voteCounts.host === 0, "the withdrawal in the totals");

    // Nobody else learns who voted for whom.
    await sleep(30);
    for (const id of ["host", "d2", "fan2"]) assert.equal(mine[id].length, 0, `${id} received someone else's vote`);
  });

  it("the voter's other tabs learn the vote too (player channel)", async () => {
    const { code, sockets } = await battle(harness, ["fan"]);
    const secondTab = await harness.client();
    const secondTabMine = record<VoteMinePayload>(secondTab, "vote:mine");
    await ok(secondTab, "room:join", { roomCode: code, playerId: "fan", displayName: "fan" });
    await waitUntil(() => secondTabMine.length === 1, "the join resync");
    assert.equal(secondTabMine[0].dancerId, null);

    await ok(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "host" });
    await waitUntil(() => secondTabMine.length === 2, "vote:mine on the second tab");
    assert.equal(secondTabMine[1].dancerId, "host");
  });

  it("a spectator rejoining after a refresh gets their own vote back (join resync)", async () => {
    const { code, sockets } = await battle(harness);
    await ok(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "d2" });
    sockets.fan.disconnect();

    const refreshed = await harness.client();
    const refreshedMine = record<VoteMinePayload>(refreshed, "vote:mine");
    await ok(refreshed, "room:join", { roomCode: code, playerId: "fan", displayName: "fan" });
    await waitUntil(() => refreshedMine.length === 1, "vote:mine on rejoin");
    assert.deepEqual(refreshedMine[0], { roomCode: code, dancerId: "d2" });
  });

  it("a socket cannot vote as another spectator (identity spoofing)", async () => {
    const { code, sockets } = await battle(harness);
    await rejected(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan2", dancerId: "d2" }, "PLAYER_NOT_IN_ROOM");
    await rejected(sockets.d2, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "d2" }, "PLAYER_NOT_IN_ROOM");
    const outsider = await harness.client();
    await rejected(outsider, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "d2" }, "PLAYER_NOT_IN_ROOM");
    assert.deepEqual((await harness.storedRoom(code)).battle!.votes, {});
  });

  it("dancers cannot vote (INVALID_VOTER), and malformed votes are refused", async () => {
    const { code, sockets } = await battle(harness);
    await rejected(sockets.d2, "vote:cast", { roomCode: code, voterId: "d2", dancerId: "d2" }, "INVALID_VOTER");
    await rejected(sockets.host, "vote:cast", { roomCode: code, voterId: "host", dancerId: "d2" }, "INVALID_VOTER");
    await rejected(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "nobody" }, "INVALID_DANCER");
    await rejected(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: 7 }, "INVALID_MESSAGE");
    await rejected(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan" }, "INVALID_MESSAGE");
    await rejected(sockets.fan, "vote:cast", null, "PLAYER_NOT_IN_ROOM");
    // A non-function ack is tolerated: the error goes to error:domain instead.
    const errors = record<{ code: string }>(sockets.fan, "error:domain");
    sockets.fan.emit("vote:cast", { roomCode: code, voterId: "fan", dancerId: "nobody" }, "not-a-function");
    await waitUntil(() => errors.length === 1, "error:domain without an ack");
    assert.equal(errors[0].code, "INVALID_DANCER");
    assert.deepEqual((await harness.storedRoom(code)).battle!.votes, {});
  });

  it("votes after the battle finished are refused with BATTLE_FINISHED", async () => {
    const { code, sockets, finished } = await battle(harness);
    await ok(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "d2" });
    await ok(sockets.host, "room:leave", { roomCode: code, playerId: "host" });
    assert.equal((await harness.storedRoom(code)).status, "finished");
    await rejected(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: null }, "BATTLE_FINISHED");
    assert.deepEqual((await harness.storedRoom(code)).battle!.votes, { fan: "d2" }, "votes are frozen");
  });
});

describe("vote:cast during the start countdown", () => {
  const harness = new SocketHarness();
  before(() => harness.start({ extend: (rooms) => ({ startBattle: new StartBattle(rooms, { countdownMs: 60_000 }) }) }));
  after(() => harness.stop());

  it("a vote before the dancing begins gets BATTLE_NOT_STARTED and nothing is stored", async () => {
    const { code, sockets } = await battle(harness, ["fan"]);
    await rejected(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "host" }, "BATTLE_NOT_STARTED");
    assert.deepEqual((await harness.storedRoom(code)).battle!.votes, {});
  });
});

describe("room:rematch over Socket.IO (HU 18)", () => {
  const harness = new SocketHarness();
  before(() => harness.start());
  after(() => harness.stop());

  /** A battle finished because d2 left (host is the only dancer left); spectator d3 dances in the rematch. */
  async function finishedRoom() {
    const room = await battle(harness, ["fan", "d3"]);
    await ok(room.sockets.fan, "vote:cast", { roomCode: room.code, voterId: "fan", dancerId: "host" });
    await ok(room.sockets.d2, "room:leave", { roomCode: room.code, playerId: "d2" });
    await waitUntil(() => room.finished.length === 1, "battle:finished");
    return room;
  }

  it("only the host can ask for it (NOT_HOST), and not while the battle runs (ROOM_NOT_FINISHED)", async () => {
    const running = await battle(harness);
    await rejected(running.sockets.host, "room:rematch", { roomCode: running.code, requesterId: "host" }, "ROOM_NOT_FINISHED");

    const { code, sockets } = await finishedRoom();
    await rejected(sockets.fan, "room:rematch", { roomCode: code, requesterId: "fan" }, "NOT_HOST");
    await rejected(sockets.fan, "room:rematch", { roomCode: code, requesterId: "host" }, "PLAYER_NOT_IN_ROOM");
    assert.equal((await harness.storedRoom(code)).status, "finished");
  });

  it("takes everyone back to the lobby, keeps the last result, clears votes and battle timers", async () => {
    const { code, sockets, updates, mine } = await finishedRoom();
    const lastResult = (await harness.storedRoom(code)).battle!.result;

    const room = await ok<RoomDto>(sockets.host, "room:rematch", { roomCode: code, requesterId: "host" });
    assert.equal(room.status, "waiting");
    assert.equal(room.battle, null);
    assert.equal(room.selectedSong, null);
    assert.deepEqual(room.lastResult, lastResult);
    assert.ok(room.players.every((p) => !p.ready), "everyone must be ready again");
    assert.equal(harness.roomTimers().pending(code), 0, "a battle timer survived the rematch");

    await waitUntil(() => updates.fan.at(-1)?.status === "waiting", "room:updated with the lobby");
    await waitUntil(() => mine.fan.at(-1)?.dancerId === null, "the spectator's vote cleared");

    // The lobby works again: roles, ready, song, start.
    await ok(sockets.d3, "role:select", { roomCode: code, playerId: "d3", role: "dancer" });
    await readyUp(code, { host: sockets.host, fan: sockets.fan, d3: sockets.d3 });
    await pickSong(harness.rooms, code);
    const restarted = await ok<RoomDto>(sockets.host, "battle:start", { roomCode: code, requesterId: "host" });
    assert.equal(restarted.status, "battling");
    assert.deepEqual(restarted.battle!.voteCounts, { host: 0, d3: 0 });
    // Close it so no timer outlives the test.
    await ok(sockets.d3, "room:leave", { roomCode: code, playerId: "d3" });
  });

  it("a non-function ack is tolerated", async () => {
    const { code, sockets } = await finishedRoom();
    const updates = record<RoomDto>(sockets.host, "room:updated");
    sockets.host.emit("room:rematch", { roomCode: code, requesterId: "host" }, 42);
    await waitUntil(() => updates.some((r) => r.status === "waiting"), "the rematch without an ack");
    const response = await emit(sockets.host, "room:rematch", { roomCode: code, requesterId: "host" });
    assert.equal(!response.ok && response.error.code, "ROOM_NOT_FINISHED");
  });
});
