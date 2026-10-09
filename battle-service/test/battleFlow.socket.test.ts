import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Room } from "../src/domain/model/Room.js";
import { readyUp } from "./support/ready.js";
import { emit, ok, record, rejected, SocketHarness, waitUntil } from "./support/socketHarness.js";

const PHRASE = "dale play";
const harness = new SocketHarness();

before(() => harness.start({ songChallenge: { durationMs: 400, phrases: [PHRASE] } }));
after(() => harness.stop());

async function lobby() {
  const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
  const host = await harness.client();
  const guest = await harness.client();
  await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
  await ok(guest, "room:join", { roomCode: code, playerId: "guest", displayName: "Guest" });
  await ok(host, "role:select", { roomCode: code, playerId: "host", role: "dancer" });
  await ok(guest, "role:select", { roomCode: code, playerId: "guest", role: "dancer" });
  return { code, host, guest };
}

/** Challenge started and the guest won the right to choose the song. */
async function guestIsChoosing() {
  const room = await lobby();
  await readyUp(room.code, { host: room.host, guest: room.guest });
  await ok(room.host, "song-challenge:start", { roomCode: room.code, requesterId: "host" });
  await ok(room.guest, "song-challenge:submit", { roomCode: room.code, playerId: "guest", text: PHRASE });
  return room;
}

describe("lobby flow: ready -> song challenge -> song choice -> battle", () => {
  it("the battle cannot start without a chosen song, even when everyone is ready", async () => {
    const { code, host, guest } = await lobby();
    await readyUp(code, { host, guest });
    await rejected(host, "battle:start", { roomCode: code, requesterId: "host" }, "SONG_NOT_SELECTED");
    assert.equal((await harness.storedRoom(code)).status, "waiting");
  });

  it("the song challenge cannot start while a player is not ready", async () => {
    const { code, host, guest } = await lobby();
    await ok(host, "player:ready", { roomCode: code, playerId: "host", ready: true });
    await rejected(host, "song-challenge:start", { roomCode: code, requesterId: "host" }, "PLAYERS_NOT_READY");
    assert.equal((await harness.storedRoom(code)).songSelection, null);

    await ok(guest, "player:ready", { roomCode: code, playerId: "guest", ready: true });
    const room = await ok<Room>(host, "song-challenge:start", { roomCode: code, requesterId: "host" });
    assert.equal(room.songSelection?.phase, "typing");
  });

  it("choosing the song starts the battle by itself and tells the whole room", async () => {
    const { code, host, guest } = await guestIsChoosing();
    const started = record<Room>(host, "battle:started");
    assert.equal((await harness.storedRoom(code)).status, "waiting");

    const room = await ok<Room>(guest, "song:choose", { roomCode: code, playerId: "guest", songId: "song-2" });

    assert.equal(room.status, "battling");
    assert.equal(room.battle?.song?.id, "song-2");
    await waitUntil(() => started.length === 1, "battle:started on the host");
    assert.equal((await harness.storedRoom(code)).status, "battling");
  });

  it("keeps the song chosen, without starting, when someone cancelled being ready meanwhile", async () => {
    const { code, host, guest } = await guestIsChoosing();
    await ok(host, "player:ready", { roomCode: code, playerId: "host", ready: false });

    const room = await ok<Room>(guest, "song:choose", { roomCode: code, playerId: "guest", songId: "song-2" });
    assert.equal(room.status, "waiting");
    assert.equal(room.selectedSong?.id, "song-2");

    // Once they are ready again the host can start with the song already chosen.
    await rejected(host, "battle:start", { roomCode: code, requesterId: "host" }, "PLAYERS_NOT_READY");
    await ok(host, "player:ready", { roomCode: code, playerId: "host", ready: true });
    const started = await ok<Room>(host, "battle:start", { roomCode: code, requesterId: "host" });
    assert.equal(started.status, "battling");
    assert.equal(started.battle?.song?.id, "song-2");
  });

  it("only the winner chooses, and an invalid song neither picks nor starts anything", async () => {
    const { code, host, guest } = await guestIsChoosing();
    const response = await emit(host, "song:choose", { roomCode: code, playerId: "host", songId: "song-2" });
    assert.equal(!response.ok && response.error.code, "NOT_SONG_CHOOSER");
    await rejected(guest, "song:choose", { roomCode: code, playerId: "guest", songId: "nope" }, "INVALID_SONG");
    assert.equal((await harness.storedRoom(code)).status, "waiting");
  });
});
