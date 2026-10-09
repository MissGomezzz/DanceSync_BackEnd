import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { ChooseSong } from "../src/application/usecases/ChooseSong.js";
import { FinishBattleAtDeadline } from "../src/application/usecases/FinishBattleAtDeadline.js";
import { KickPlayer } from "../src/application/usecases/KickPlayer.js";
import { CreateRoom } from "../src/application/usecases/CreateRoom.js";
import { ExpireWordRound } from "../src/application/usecases/ExpireWordRound.js";
import { GetActiveWordRound } from "../src/application/usecases/GetActiveWordRound.js";
import { JoinRoom } from "../src/application/usecases/JoinRoom.js";
import { OpenWordRound } from "../src/application/usecases/OpenWordRound.js";
import { RateDancer } from "../src/application/usecases/RateDancer.js";
import { SelectRole } from "../src/application/usecases/SelectRole.js";
import { SetReady } from "../src/application/usecases/SetReady.js";
import { SendChatMessage } from "../src/application/usecases/SendChatMessage.js";
import { StartBattle } from "../src/application/usecases/StartBattle.js";
import { StartSongChallenge } from "../src/application/usecases/StartSongChallenge.js";
import { StartWordRace } from "../src/application/usecases/StartWordRace.js";
import { StopWordRace } from "../src/application/usecases/StopWordRace.js";
import { SubmitSongPhrase } from "../src/application/usecases/SubmitSongPhrase.js";
import { SubmitWord } from "../src/application/usecases/SubmitWord.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";
import { InMemoryWordRaceRepository } from "../src/infrastructure/persistence/InMemoryWordRaceRepository.js";
import { WordRaceScheduler } from "../src/infrastructure/scheduling/WordRaceScheduler.js";
import type { WordRoundEndedPayload, WordRoundStartedPayload } from "../src/infrastructure/ws/events.js";
import { registerSocketHandlers, type BattleServer } from "../src/infrastructure/ws/socketHandlers.js";
import { createSocketWordRaceBroadcaster } from "../src/infrastructure/ws/wordRaceMessages.js";
import { pickSong, readyUp } from "./support/ready.js";
import type { Room } from "../src/domain/model/Room.js";
import { AwardWordBonus } from "../src/application/usecases/AwardWordBonus.js";

/** Round openings (ms after the battle starts) and window, shrunk so the test runs in about a second. */
const OFFSETS_MS = [100, 1400, 2700, 4000];
const WINDOW_MS = 1000;

type AckResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
type SubmitAck = { outcome: string; winnerId: string | null };

let httpServer: HttpServer;
let io: BattleServer;
let url: string;
let createRoom: CreateRoom;
let rooms: InMemoryRoomRepository;
let scheduler: WordRaceScheduler;
const clients: ClientSocket[] = [];

interface Recorded {
  socket: ClientSocket;
  started: WordRoundStartedPayload[];
  ended: WordRoundEndedPayload[];
  updates: Room[];
}

function emit<T>(socket: ClientSocket, event: string, payload: unknown): Promise<AckResponse<T>> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function ok<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  const response = await emit<T>(socket, event, payload);
  if (!response.ok) assert.fail(`${event} failed: ${response.error.code} ${response.error.message}`);
  return response.data;
}

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await sleep(5);
  }
}

/** Connects a client that records every word race event from the start. */
async function client(): Promise<Recorded> {
  const socket = connect(url, { path: "/socket.io", transports: ["websocket"], forceNew: true });
  clients.push(socket);
  const recorded: Recorded = { socket, started: [], ended: [], updates: [] };
  socket.on("word:round-started", (payload: WordRoundStartedPayload) => recorded.started.push(payload));
  socket.on("word:round-ended", (payload: WordRoundEndedPayload) => recorded.ended.push(payload));
  socket.on("room:updated", (room: Room) => recorded.updates.push(room));
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
  return recorded;
}

/** Battle with dancers `host` and `guest` and the spectator `fan`, all recording events. */
async function battle(): Promise<{ code: string; host: Recorded; guest: Recorded; fan: Recorded }> {
  const created = await createRoom.execute({ hostId: "host", displayName: "Host" });
  const code = created.code;
  const host = await client();
  const guest = await client();
  const fan = await client();
  await ok(host.socket, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
  await ok(guest.socket, "room:join", { roomCode: code, playerId: "guest", displayName: "Guest" });
  await ok(fan.socket, "room:join", { roomCode: code, playerId: "fan", displayName: "Fan" });
  await ok(host.socket, "role:select", { roomCode: code, playerId: "host", role: "dancer" });
  await ok(guest.socket, "role:select", { roomCode: code, playerId: "guest", role: "dancer" });
  await ok(fan.socket, "role:select", { roomCode: code, playerId: "fan", role: "spectator" });
  await readyUp(code, { host: host.socket, guest: guest.socket, fan: fan.socket });
  await pickSong(rooms, code);
  await ok(host.socket, "battle:start", { roomCode: code, requesterId: "host" });
  return { code, host, guest, fan };
}

function submit(who: Recorded, code: string, playerId: string, roundId: string, text: string) {
  return emit<SubmitAck>(who.socket, "word:submit", { roomCode: code, playerId, roundId, text });
}

function endedFor(who: Recorded, roundId: string): WordRoundEndedPayload[] {
  return who.ended.filter((e) => e.roundId === roundId);
}

before(async () => {
  rooms = new InMemoryRoomRepository();
  const races = new InMemoryWordRaceRepository();
  createRoom = new CreateRoom(rooms);
  httpServer = createServer();
  io = new Server(httpServer, { path: "/socket.io" });
  scheduler = new WordRaceScheduler({
    startWordRace: new StartWordRace(rooms, races, { offsetsMs: OFFSETS_MS, windowMs: WINDOW_MS }),
    openWordRound: new OpenWordRound(rooms, races),
    expireWordRound: new ExpireWordRound(races),
    stopWordRace: new StopWordRace(races),
    broadcaster: createSocketWordRaceBroadcaster(io),
  });
  registerSocketHandlers(io, {
    joinRoom: new JoinRoom(rooms),
    startBattle: new StartBattle(rooms),
    selectRole: new SelectRole(rooms),
    setReady: new SetReady(rooms),
    sendChatMessage: new SendChatMessage(rooms),
    rateDancer: new RateDancer(rooms),
    startSongChallenge: new StartSongChallenge(rooms),
    submitSongPhrase: new SubmitSongPhrase(rooms),
    chooseSong: new ChooseSong(rooms),
    finishBattleAtDeadline: new FinishBattleAtDeadline(rooms),
    kickPlayer: new KickPlayer(rooms),
    disconnectGraceMs: 50,
    wordRace: { scheduler, submitWord: new SubmitWord(races), awardWordBonus: new AwardWordBonus(rooms), getActiveWordRound: new GetActiveWordRound(races) },
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  for (const socket of clients) socket.disconnect();
  await io.close();
  assert.equal(scheduler.pendingTimers(), 0, "word race timers leaked");
});

describe("Word race over Socket.IO", () => {
  it("broadcasts the word to everyone and lets exactly one of two simultaneous dancers win", async () => {
    const { code, host, guest, fan } = await battle();
    const everyone = [host, guest, fan];

    await waitUntil(() => everyone.every((r) => r.started.length === 1), "round 1 on every socket");
    const round = host.started[0];
    assert.equal(round.roundNumber, 1);
    assert.equal(round.totalRounds, OFFSETS_MS.length);
    assert.ok(round.expiresInMs > 0 && round.expiresInMs <= WINDOW_MS);
    assert.ok(everyone.every((r) => r.started[0].word === round.word && r.started[0].roundId === round.roundId));

    // Both dancers type the word at the same moment.
    const [hostAck, guestAck] = await Promise.all([
      submit(host, code, "host", round.roundId, round.word),
      submit(guest, code, "guest", round.roundId, round.word),
    ]);
    assert.ok(hostAck.ok && guestAck.ok);
    const outcomes = [hostAck.data.outcome, guestAck.data.outcome].sort();
    assert.deepEqual(outcomes, ["late", "won"]);
    const winnerId = hostAck.data.outcome === "won" ? "host" : "guest";
    assert.equal(hostAck.data.winnerId, winnerId);
    assert.equal(guestAck.data.winnerId, winnerId);

    await waitUntil(() => everyone.every((r) => endedFor(r, round.roundId).length > 0), "round 1 end on every socket");
    // Wait past closesAt so a duplicate announcement from the expiry timer would show up.
    await sleep(WINDOW_MS + 50);
    for (const recorded of everyone) {
      const ended = endedFor(recorded, round.roundId);
      assert.equal(ended.length, 1, "word:round-ended must be broadcast exactly once");
      assert.equal(ended[0].reason, "won");
      assert.equal(ended[0].winnerId, winnerId);
      assert.equal(ended[0].winnerName, winnerId === "host" ? "Host" : "Guest");
      assert.deepEqual(ended[0].wins, { host: winnerId === "host" ? 1 : 0, guest: winnerId === "guest" ? 1 : 0 });
      assert.equal(ended[0].bonusPoints, 1, "the round winner earns the bonus");
    }
    // The bonus is registered at once, for the winner only, and is visible to the whole room.
    const stored = (await rooms.findByCode(code))!;
    assert.deepEqual(stored.battle!.bonusPoints, { host: winnerId === "host" ? 1 : 0, guest: winnerId === "guest" ? 1 : 0 });
    await waitUntil(
      () => fan.updates.some((r) => r.battle?.bonusPoints[winnerId] === 1),
      "the spectator to see the bonus in room:updated",
    );

    const spectator = await submit(fan, code, "fan", round.roundId, round.word);
    assert.equal(!spectator.ok && spectator.error.code, "NOT_CHALLENGE_PARTICIPANT");
    const impersonation = await submit(fan, code, "host", round.roundId, round.word);
    assert.equal(!impersonation.ok && impersonation.error.code, "PLAYER_NOT_IN_ROOM");

    // Finishing the battle (every spectator rated every dancer) stops the race.
    await ok(fan.socket, "rating:submit", { roomCode: code, raterId: "fan", dancerId: "host", score: 4 });
    await ok(fan.socket, "rating:submit", { roomCode: code, raterId: "fan", dancerId: "guest", score: 3 });
    assert.equal(scheduler.pendingTimers(code), 0);
    await sleep(OFFSETS_MS[1] + 100);
    assert.ok(everyone.every((r) => r.started.length === 1), "a round started after the battle finished");
  });

  it("allows retries after a typo, expires unanswered rounds, resyncs a rejoining client and stops when the room is gone", async () => {
    const { code, host, guest, fan } = await battle();
    const everyone = [host, guest, fan];

    // Round 1: a typo does not lock the dancer out.
    await waitUntil(() => host.started.length === 1, "round 1");
    const first = host.started[0];
    const typo = await submit(host, code, "host", first.roundId, `${first.word}x`);
    assert.ok(typo.ok);
    assert.deepEqual(typo.data, { outcome: "incorrect", winnerId: null });
    assert.deepEqual((await rooms.findByCode(code))!.battle!.bonusPoints, { host: 0, guest: 0 }, "a typo earns nothing");
    const retry = await submit(host, code, "host", first.roundId, ` ${first.word.toUpperCase()} `);
    assert.ok(retry.ok);
    assert.equal(retry.data.outcome, "won");

    // Round 2: a refreshed client gets the word with the time left; nobody answers.
    await waitUntil(() => host.started.length === 2, "round 2");
    const second = host.started[1];
    assert.equal(second.roundNumber, 2);
    const rejoined = await client();
    await ok(rejoined.socket, "room:join", { roomCode: code, playerId: "guest", displayName: "Guest" });
    await waitUntil(() => rejoined.started.length === 1, "round 2 resync on rejoin");
    assert.equal(rejoined.started[0].roundId, second.roundId);
    assert.ok(rejoined.started[0].expiresInMs > 0 && rejoined.started[0].expiresInMs <= WINDOW_MS);

    await waitUntil(() => everyone.every((r) => endedFor(r, second.roundId).length === 1), "round 2 expiry");
    for (const recorded of everyone) {
      const [ended] = endedFor(recorded, second.roundId);
      assert.equal(ended.reason, "expired");
      assert.equal(ended.winnerId, null);
      assert.equal(ended.word, second.word);
      assert.deepEqual(ended.wins, { host: 1, guest: 0 });
      assert.equal(ended.bonusPoints, 0, "an unanswered round pays no bonus");
    }
    // The round that expired leaves the bonus won earlier untouched.
    assert.deepEqual((await rooms.findByCode(code))!.battle!.bonusPoints, { host: 1, guest: 0 });
    const late = await submit(guest, code, "guest", second.roundId, second.word);
    assert.ok(late.ok);
    assert.equal(late.data.outcome, "expired");
    assert.deepEqual((await rooms.findByCode(code))!.battle!.bonusPoints, { host: 1, guest: 0 }, "a late answer earns nothing");

    // Everyone leaves: the room is deleted and no further round may start.
    await ok(fan.socket, "room:leave", { roomCode: code, playerId: "fan" });
    await ok(guest.socket, "room:leave", { roomCode: code, playerId: "guest" });
    await ok(host.socket, "room:leave", { roomCode: code, playerId: "host" });
    assert.equal(scheduler.pendingTimers(code), 0);
    await sleep(OFFSETS_MS[2] - OFFSETS_MS[1]);
    assert.ok(everyone.every((r) => r.started.length === 2), "a round started after the room was deleted");
  });
});
