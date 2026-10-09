import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import type { Room } from "../src/domain/model/Room.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { SongSelectionService, type RandomIndex } from "../src/domain/services/SongSelectionService.js";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { toRoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { allReady, readyUp } from "./support/ready.js";
import { ok, record, SocketHarness, waitUntil } from "./support/socketHarness.js";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const PHRASE = "baila conmigo";
const CHALLENGE_MS = 10_000;
const CHOOSE_MS = 20_000;
const first: RandomIndex = () => 0;
const last: RandomIndex = (n) => n - 1;

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

/** Two ready dancers (a, b) plus the host as a ready spectator; the challenge started at T0. */
function typing(): Room {
  let room = RoomService.create({ id: "host", displayName: "Host" }, "ROOM01");
  for (const id of ["a", "b"]) room = RoomService.join(room, { id, displayName: id.toUpperCase() });
  room = RoomService.selectRole(room, "host", "spectator");
  room = RoomService.selectRole(room, "a", "dancer");
  room = RoomService.selectRole(room, "b", "dancer");
  return SongSelectionService.start(allReady(room), {
    now: T0,
    durationMs: CHALLENGE_MS,
    chooseMs: CHOOSE_MS,
    phrases: [PHRASE],
  });
}

function aChoosing(): Room {
  return SongSelectionService.submit(typing(), "a", PHRASE, at(1_000)).room;
}

describe("Song choice deadline (domain)", () => {
  it("the winner of the phrase gets SONG_CHOOSE_MS to pick, counted from the win", () => {
    const selection = aChoosing().songSelection!;
    assert.equal(selection.phase, "choosing");
    assert.equal(selection.chooseDeadline!.getTime(), at(1_000 + CHOOSE_MS).getTime());
    assert.equal(selection.autoPicked, false);
  });

  it("a chooser assigned by the fallback also gets a deadline", () => {
    const room = typing();
    const expired = SongSelectionService.expire(room, room.songSelection!.challenge.id, first, at(CHALLENGE_MS))!;
    assert.equal(expired.songSelection!.chooseDeadline!.getTime(), at(CHALLENGE_MS + CHOOSE_MS).getTime());
  });

  it("the turn passed on after the chooser leaves comes with a fresh deadline", () => {
    const left = RoomService.leave(aChoosing(), "a", at(5_000));
    assert.equal(left.songSelection!.chooserId, "b");
    assert.equal(left.songSelection!.chooseDeadline!.getTime(), at(5_000 + CHOOSE_MS).getTime());
  });

  it("autoPick does nothing before the deadline, for another challenge, or once the song was chosen", () => {
    const room = aChoosing();
    const challengeId = room.songSelection!.challenge.id;
    assert.equal(SongSelectionService.autoPick(room, challengeId, at(1_000 + CHOOSE_MS - 1), first), null);
    assert.equal(SongSelectionService.autoPick(room, "another-challenge", at(1_000 + CHOOSE_MS), first), null);
    const chosen = SongSelectionService.choose(room, "a", room.songSelection!.songOptions[1].id);
    assert.equal(SongSelectionService.autoPick(chosen, challengeId, at(1_000 + CHOOSE_MS), first), null);
  });

  it("autoPick picks a random option for the chooser once the deadline passed", () => {
    const room = aChoosing();
    const options = room.songSelection!.songOptions;
    const picked = SongSelectionService.autoPick(room, room.songSelection!.challenge.id, at(1_000 + CHOOSE_MS), last)!;
    assert.equal(picked.songSelection!.phase, "done");
    assert.equal(picked.songSelection!.autoPicked, true);
    assert.equal(picked.songSelection!.chooseDeadline, null);
    assert.deepEqual(picked.selectedSong, options[options.length - 1]);
    // The picked song can start the battle exactly like a manual choice.
    assert.equal(RoomService.startBattle(picked).status, "battling");
  });

  it("the DTO exposes the time left to choose only while choosing", () => {
    const room = aChoosing();
    assert.equal(toRoomDto(room, at(6_000)).songSelection!.chooseExpiresInMs, CHOOSE_MS - 5_000);
    assert.equal(toRoomDto(room, at(1_000 + CHOOSE_MS + 50)).songSelection!.chooseExpiresInMs, 0);
    assert.equal(toRoomDto(typing(), at(1_000)).songSelection!.chooseExpiresInMs, null);
    const chosen = SongSelectionService.choose(room, "a", room.songSelection!.songOptions[0].id);
    assert.equal(toRoomDto(chosen, at(2_000)).songSelection!.chooseExpiresInMs, null);
    assert.equal(toRoomDto(chosen, at(2_000)).songSelection!.autoPicked, false);
  });
});

describe("Song choice deadline over Socket.IO", () => {
  const SOCKET_CHOOSE_MS = 200;
  const harness = new SocketHarness();
  before(() => harness.start({ songChallenge: { durationMs: 5_000, chooseMs: SOCKET_CHOOSE_MS, phrases: [PHRASE] } }));
  after(() => harness.stop());

  async function guestChoosing() {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const host = await harness.client();
    const guest = await harness.client();
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await ok(guest, "room:join", { roomCode: code, playerId: "guest", displayName: "Guest" });
    await ok(host, "role:select", { roomCode: code, playerId: "host", role: "dancer" });
    await ok(guest, "role:select", { roomCode: code, playerId: "guest", role: "dancer" });
    await readyUp(code, { host, guest });
    await ok(host, "song-challenge:start", { roomCode: code, requesterId: "host" });
    const result = await ok<{ room: RoomDto }>(guest, "song-challenge:submit", {
      roomCode: code,
      playerId: "guest",
      text: PHRASE,
    });
    return { code, host, guest, room: result.room };
  }

  it("a chooser who never picks gets a random song and the battle starts by itself", async () => {
    const { code, host, room } = await guestChoosing();
    assert.equal(room.songSelection!.phase, "choosing");
    assert.ok(room.songSelection!.chooseExpiresInMs! > 0 && room.songSelection!.chooseExpiresInMs! <= SOCKET_CHOOSE_MS);
    const started = record<RoomDto>(host, "battle:started");

    await waitUntil(() => started.length === 1, "battle:started after the choice deadline");
    assert.equal(started[0].status, "battling");
    assert.equal(started[0].songSelection!.autoPicked, true);
    assert.equal(started[0].songSelection!.chooseExpiresInMs, null);
    assert.ok(started[0].battle!.song, "the battle dances to the picked song");
    assert.equal((await harness.storedRoom(code)).status, "battling");
    assert.equal(harness.roomTimers().has(code, "song-choose"), false, "the choice timer was not cleared");
  });

  it("a manual choice before the deadline wins; the timer then changes nothing", async () => {
    const { code, guest } = await guestChoosing();
    await ok(guest, "song:choose", { roomCode: code, playerId: "guest", songId: "song-3" });
    await sleep(SOCKET_CHOOSE_MS + 100);
    const stored = await harness.storedRoom(code);
    assert.equal(stored.selectedSong!.id, "song-3");
    assert.equal(stored.songSelection!.autoPicked, false);
    assert.equal(stored.status, "battling");
  });
});
