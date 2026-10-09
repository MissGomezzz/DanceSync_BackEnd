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
import { ReapRooms } from "../src/application/usecases/ReapRooms.js";
import { CreateRoom } from "../src/application/usecases/CreateRoom.js";
import { ExpireWordRound } from "../src/application/usecases/ExpireWordRound.js";
import { GetActiveWordRound } from "../src/application/usecases/GetActiveWordRound.js";
import { JoinRoom } from "../src/application/usecases/JoinRoom.js";
import { OpenWordRound } from "../src/application/usecases/OpenWordRound.js";
import { CastVote } from "../src/application/usecases/CastVote.js";
import { StartRematch } from "../src/application/usecases/StartRematch.js";
import { SelectRole } from "../src/application/usecases/SelectRole.js";
import { SetReady } from "../src/application/usecases/SetReady.js";
import { SendChatMessage } from "../src/application/usecases/SendChatMessage.js";
import { StartBattle } from "../src/application/usecases/StartBattle.js";
import { StartSongChallenge } from "../src/application/usecases/StartSongChallenge.js";
import { StartWordRace } from "../src/application/usecases/StartWordRace.js";
import { StopWordRace } from "../src/application/usecases/StopWordRace.js";
import { SubmitSongPhrase } from "../src/application/usecases/SubmitSongPhrase.js";
import { SubmitWord } from "../src/application/usecases/SubmitWord.js";
import type { RoomDto as Room } from "../src/infrastructure/serialization/roomDto.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";
import { InMemoryWordRaceRepository } from "../src/infrastructure/persistence/InMemoryWordRaceRepository.js";
import { WordRaceScheduler } from "../src/infrastructure/scheduling/WordRaceScheduler.js";
import type { VoteMinePayload, WordRoundStartedPayload } from "../src/infrastructure/ws/events.js";
import { registerSocketHandlers, type BattleServer, type SocketHandlersHandle } from "../src/infrastructure/ws/socketHandlers.js";
import { createSocketWordRaceBroadcaster } from "../src/infrastructure/ws/wordRaceMessages.js";
import { pickSong, readyUp } from "./support/ready.js";
import { AwardWordBonus } from "../src/application/usecases/AwardWordBonus.js";

/**
 * Round openings (ms after the battle starts), shrunk so the test runs quickly.
 * The window must comfortably outlast a loaded machine's scheduling delays (the
 * suite runs files in parallel): with a 150 ms window the round sometimes
 * expired before the winning submission arrived. The second round opens well
 * after the first one closes, so "round 1" is never confused with "round 2".
 */
const OFFSETS_MS = [300, 2000];
const WINDOW_MS = 1000;
const GRACE_MS = 50;

type AckResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

let httpServer: HttpServer;
let io: BattleServer;
let handlers: SocketHandlersHandle;
let url: string;
let createRoom: CreateRoom;
let rooms: InMemoryRoomRepository;
let scheduler: WordRaceScheduler;
const clients: ClientSocket[] = [];

interface Recorded {
  socket: ClientSocket;
  finished: Room[];
  started: WordRoundStartedPayload[];
  votes: VoteMinePayload[];
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

async function client(): Promise<Recorded> {
  const socket = connect(url, { path: "/socket.io", transports: ["websocket"], forceNew: true });
  clients.push(socket);
  const recorded: Recorded = { socket, finished: [], started: [], votes: [] };
  socket.on("vote:mine", (payload: VoteMinePayload) => recorded.votes.push(payload));
  socket.on("battle:finished", (room: Room) => recorded.finished.push(room));
  socket.on("word:round-started", (payload: WordRoundStartedPayload) => recorded.started.push(payload));
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
  return recorded;
}

/** Running battle; `host` must be the first dancer. Every player records events on its own socket. */
async function battle(
  dancers: string[],
  spectators: string[] = ["fan"],
): Promise<{ code: string; sockets: Record<string, Recorded> }> {
  const created = await createRoom.execute({ hostId: "host", displayName: "Host" });
  const code = created.code;
  const sockets: Record<string, Recorded> = {};
  for (const id of [...dancers, ...spectators]) {
    const role = dancers.includes(id) ? "dancer" : "spectator";
    sockets[id] = await client();
    await ok(sockets[id].socket, "room:join", { roomCode: code, playerId: id, displayName: id });
    await ok(sockets[id].socket, "role:select", { roomCode: code, playerId: id, role });
  }
  await readyUp(code, Object.fromEntries(Object.entries(sockets).map(([id, recorded]) => [id, recorded.socket])));
  await pickSong(rooms, code);
  await ok(sockets.host.socket, "battle:start", { roomCode: code, requesterId: "host" });
  return { code, sockets };
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
  handlers = registerSocketHandlers(io, {
    joinRoom: new JoinRoom(rooms),
    startBattle: new StartBattle(rooms),
    selectRole: new SelectRole(rooms),
    setReady: new SetReady(rooms),
    sendChatMessage: new SendChatMessage(rooms),
    castVote: new CastVote(rooms),
    startRematch: new StartRematch(rooms),
    startSongChallenge: new StartSongChallenge(rooms),
    submitSongPhrase: new SubmitSongPhrase(rooms),
    chooseSong: new ChooseSong(rooms),
    finishBattleAtDeadline: new FinishBattleAtDeadline(rooms),
    kickPlayer: new KickPlayer(rooms),
    reapRooms: new ReapRooms(rooms),
    disconnectGraceMs: GRACE_MS,
    wordRace: { scheduler, submitWord: new SubmitWord(races), awardWordBonus: new AwardWordBonus(rooms), getActiveWordRound: new GetActiveWordRound(races) },
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  for (const socket of clients) socket.disconnect();
  handlers.close();
  await io.close();
  assert.equal(scheduler.pendingTimers(), 0, "word race timers leaked");
});

describe("Leaving during a battle over Socket.IO", () => {
  it("a dancer leaving with two dancers left keeps the battle and the word race going", async () => {
    const { code, sockets } = await battle(["host", "d2", "d3"]);
    const { host, d2, d3, fan } = sockets;
    await ok(fan.socket, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "d3" });

    const room = await ok<Room>(d3.socket, "room:leave", { roomCode: code, playerId: "d3" });
    assert.equal(room.status, "battling");
    assert.deepEqual(room.battle!.dancerIds, ["host", "d2"]);
    assert.ok(scheduler.pendingTimers(code) > 0, "the word race was stopped");
    // The vote for the dancer who left is discarded, and its spectator is told so.
    assert.deepEqual(room.battle!.voteCounts, { host: 0, d2: 0 });
    await waitUntil(() => fan.votes.at(-1)?.dancerId === null && fan.votes.length === 2, "vote:mine null for the fan");

    // The word race keeps running for the remaining dancers.
    await waitUntil(() => host.started.length >= 1, "round 1 after the departure");
    const round = host.started[0];
    const win = await ok<{ outcome: string }>(d2.socket, "word:submit", {
      roomCode: code,
      playerId: "d2",
      roundId: round.roundId,
      text: round.word,
    });
    assert.equal(win.outcome, "won");

    // The fan votes again, for d2; then the host leaves too and the battle ends
    // with a result over the dancer who stayed: 1 vote (2 points) + 1 word (1 point).
    await ok(fan.socket, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "d2" });
    await ok(host.socket, "room:leave", { roomCode: code, playerId: "host" });
    await waitUntil(() => fan.finished.length === 1, "battle:finished");
    assert.equal(fan.finished[0].battle!.endReason, "not-enough-dancers");
    assert.deepEqual(fan.finished[0].battle!.result, {
      standings: [{ dancerId: "d2", displayName: "d2", votes: 1, wordsWon: 1, score: 3, rank: 1 }],
      winnerId: "d2",
    });
    assert.equal(scheduler.pendingTimers(code), 0);
  });

  it("a dancer leaving with one dancer left ends the battle early and stops the word race", async () => {
    const { code, sockets } = await battle(["host", "d2"]);
    const { host, d2, fan } = sockets;

    const room = await ok<Room>(d2.socket, "room:leave", { roomCode: code, playerId: "d2" });
    assert.equal(room.status, "finished");
    assert.equal(room.battle!.endReason, "not-enough-dancers");

    await waitUntil(() => host.finished.length === 1 && fan.finished.length === 1, "battle:finished on every socket");
    assert.equal(fan.finished[0].status, "finished");
    // The dancer who stayed is the only one ranked.
    assert.deepEqual(fan.finished[0].battle!.result!.standings.map((s) => s.dancerId), ["host"]);
    assert.deepEqual(fan.finished[0].lastResult, fan.finished[0].battle!.result);
    assert.equal(d2.finished.length, 0, "the player who left is no longer in the room channel");
    assert.equal(scheduler.pendingTimers(code), 0);

    // Normally no round opened yet (the first one is OFFSETS_MS[0] after the start);
    // either way none may open once the battle is over.
    const seen = [host.started.length, fan.started.length];
    await sleep(OFFSETS_MS[OFFSETS_MS.length - 1] + WINDOW_MS);
    assert.deepEqual([host.started.length, fan.started.length], seen, "a word round started after the battle ended");
  });

  it("a dancer whose seat is released after a disconnect also ends the battle", async () => {
    const { code, sockets } = await battle(["host", "d2"]);
    const { d2, fan } = sockets;

    d2.socket.disconnect();
    await waitUntil(() => fan.finished.length === 1, "battle:finished after the disconnect grace period");
    assert.equal(fan.finished[0].battle!.endReason, "not-enough-dancers");
    assert.equal(scheduler.pendingTimers(code), 0);
  });

  it("a spectator leaving loses their vote and the battle goes on", async () => {
    const { code, sockets } = await battle(["host", "d2"], ["fan", "fan2"]);
    const { host, fan, fan2 } = sockets;
    await ok(fan.socket, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "host" });
    await ok(fan2.socket, "vote:cast", { roomCode: code, voterId: "fan2", dancerId: "host" });

    const room = await ok<Room>(fan2.socket, "room:leave", { roomCode: code, playerId: "fan2" });
    assert.equal(room.status, "battling");
    assert.deepEqual(room.battle!.voteCounts, { host: 1, d2: 0 });
    assert.equal(room.battle!.standings[0].score, 2);
    assert.deepEqual((await rooms.findByCode(code))!.battle!.votes, { fan: "host" });
    assert.equal(host.finished.length, 0);
    assert.ok(scheduler.pendingTimers(code) > 0, "the word race was stopped");

    // Close the battle so no word race timer outlives the test.
    await ok(host.socket, "room:leave", { roomCode: code, playerId: "host" });
    assert.equal(scheduler.pendingTimers(code), 0);
  });
});
