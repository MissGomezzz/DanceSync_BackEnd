import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { SONG_CATALOG } from "../src/domain/catalog/songs.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { toRoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { at, battleRoom } from "./support/battles.js";
import { readyUp } from "./support/ready.js";
import { emit, ok, record, SocketHarness, waitUntil } from "./support/socketHarness.js";

const COUNTDOWN_MS = 5_000;
const SONG_MS = SONG_CATALOG[0].durationSeconds * 1000;
const ENDS_AT = COUNTDOWN_MS + SONG_MS;

describe("Automatic battle end at the song end (domain)", () => {
  it("ends exactly at startedAt + song clip, with no grace period", () => {
    const room = battleRoom(["a", "b"], ["s"], { countdownMs: COUNTDOWN_MS });
    assert.equal(room.battle!.endsAt.getTime(), at(ENDS_AT).getTime());
    assert.equal(toRoomDto(room, at(COUNTDOWN_MS)).battle!.endsInMs, SONG_MS);
  });

  it("does nothing before endsAt", () => {
    const room = battleRoom(["a", "b"], ["s"], { countdownMs: COUNTDOWN_MS });
    assert.equal(RoomService.finishAtDeadline(room, at(ENDS_AT - 1)), room);
  });

  it("with nothing collected finishes as a draw between every dancer", () => {
    const room = RoomService.finishAtDeadline(battleRoom(["a", "b"], [], { countdownMs: COUNTDOWN_MS }), at(ENDS_AT));
    assert.equal(room.status, "finished");
    assert.equal(room.battle!.endReason, "song-end");
    assert.equal(room.battle!.result!.winnerId, null);
    assert.deepEqual(room.battle!.result!.standings.map((s) => [s.dancerId, s.rank]), [["a", 1], ["b", 1]]);
    assert.equal(room.battle!.finishedAt!.getTime(), at(ENDS_AT).getTime());
    assert.equal(toRoomDto(room, at(ENDS_AT)).battle!.endsInMs, null);
  });

  it("finishes with the votes collected so far, over the remaining dancers", () => {
    let room = battleRoom(["a", "b", "c"], ["s1", "s2"], { countdownMs: COUNTDOWN_MS });
    room = RoomService.castVote(room, "s1", "c", at(COUNTDOWN_MS + 1));
    room = RoomService.castVote(room, "s2", "a", at(COUNTDOWN_MS + 2));
    room = RoomService.leave(room, "c", at(COUNTDOWN_MS + 3));
    room = RoomService.finishAtDeadline(room, at(ENDS_AT));
    assert.equal(room.status, "finished");
    assert.equal(room.battle!.result!.winnerId, "a");
    assert.deepEqual(room.battle!.result!.standings.map((s) => [s.dancerId, s.votes, s.score]), [
      ["a", 1, 2],
      ["b", 0, 0],
    ]);
  });

  it("is a no-op on a battle already finished", () => {
    const finished = RoomService.finishAtDeadline(battleRoom(["a", "b"], []), at(SONG_MS));
    assert.equal(RoomService.finishAtDeadline(finished, at(SONG_MS + 1)), finished);
  });
});

describe("Automatic battle end over Socket.IO", () => {
  /** Long enough for a vote or a leave to land before the end on a loaded machine. */
  const CLIP_MS = 800;
  const harness = new SocketHarness();
  before(() => harness.start());
  after(() => harness.stop());

  /** Battle on a CLIP_MS clip (no countdown in the harness), so it ends CLIP_MS after the start. */
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
    await harness.rooms.update(code, (room) => ({
      ...room,
      selectedSong: { ...SONG_CATALOG[0], durationSeconds: CLIP_MS / 1000 },
    }));
    const finished = record<RoomDto>(sockets.host, "battle:finished");
    const started = await ok<RoomDto>(sockets.host, "battle:start", { roomCode: code, requesterId: "host" });
    assert.ok(started.battle!.endsInMs! > 0 && started.battle!.endsInMs! <= CLIP_MS);
    return { code, sockets, finished };
  }

  it("a battle without spectators finishes on its own at the song end", async () => {
    const { code, finished } = await shortBattle([]);
    await waitUntil(() => finished.length === 1, "battle:finished at the song end");
    assert.equal(finished[0].status, "finished");
    assert.equal(finished[0].battle!.endReason, "song-end");
    assert.equal(finished[0].battle!.result!.winnerId, null);
    assert.equal(finished[0].battle!.endsInMs, null);
    assert.equal(harness.roomTimers().pending(code), 0, "a battle timer leaked");
  });

  it("a battle whose last spectator left still finishes on its own", async () => {
    const { code, sockets, finished } = await shortBattle(["fan"]);
    const left = await ok<RoomDto>(sockets.fan, "room:leave", { roomCode: code, playerId: "fan" });
    assert.equal(left.status, "battling", "the battle goes on without spectators");
    await waitUntil(() => finished.length === 1, "battle:finished at the song end");
  });

  it("finishes with the votes collected, freezes them and announces the end once", async () => {
    const { code, sockets, finished } = await shortBattle(["fan", "lazy"]);
    await ok(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "d2" });
    await waitUntil(() => finished.length === 1, "battle:finished at the song end");
    assert.equal(finished[0].battle!.result!.winnerId, "d2");
    assert.deepEqual(finished[0].battle!.voteCounts, { host: 0, d2: 1 });
    assert.deepEqual(finished[0].battle!.standings, finished[0].battle!.result!.standings);
    assert.equal(harness.roomTimers().pending(code), 0);

    const late = await emit(sockets.lazy, "vote:cast", { roomCode: code, voterId: "lazy", dancerId: "host" });
    assert.equal(!late.ok && late.error.code, "BATTLE_FINISHED");
    assert.equal(finished.length, 1);
  });
});
