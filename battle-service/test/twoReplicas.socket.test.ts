import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { AwardWordBonus } from "../src/application/usecases/AwardWordBonus.js";
import { CastVote } from "../src/application/usecases/CastVote.js";
import { ChooseSong } from "../src/application/usecases/ChooseSong.js";
import { CreateRoom } from "../src/application/usecases/CreateRoom.js";
import { ExpireWordRound } from "../src/application/usecases/ExpireWordRound.js";
import { FinishBattleAtDeadline } from "../src/application/usecases/FinishBattleAtDeadline.js";
import { GetActiveWordRound } from "../src/application/usecases/GetActiveWordRound.js";
import { JoinRoom } from "../src/application/usecases/JoinRoom.js";
import { KickPlayer } from "../src/application/usecases/KickPlayer.js";
import { OpenWordRound } from "../src/application/usecases/OpenWordRound.js";
import { ReapRooms } from "../src/application/usecases/ReapRooms.js";
import { RecordMatchResult } from "../src/application/usecases/RecordMatchResult.js";
import { SelectRole } from "../src/application/usecases/SelectRole.js";
import { SendChatMessage } from "../src/application/usecases/SendChatMessage.js";
import { SetReady } from "../src/application/usecases/SetReady.js";
import { StartBattle } from "../src/application/usecases/StartBattle.js";
import { StartRematch } from "../src/application/usecases/StartRematch.js";
import { StartSongChallenge } from "../src/application/usecases/StartSongChallenge.js";
import { StartWordRace } from "../src/application/usecases/StartWordRace.js";
import { ResumeWordRace } from "../src/application/usecases/ResumeWordRace.js";
import { StopWordRace } from "../src/application/usecases/StopWordRace.js";
import { SubmitSongPhrase } from "../src/application/usecases/SubmitSongPhrase.js";
import { SubmitWord } from "../src/application/usecases/SubmitWord.js";
import type { MatchRecord } from "../src/domain/model/MatchRecord.js";
import type { MatchResultPublisher } from "../src/domain/ports/MatchResultPublisher.js";
import { RedisMatchOutbox } from "../src/infrastructure/redis/RedisMatchOutbox.js";
import { createStateStores, type StateStores } from "../src/infrastructure/redis/stateStores.js";
import { WordRaceScheduler } from "../src/infrastructure/scheduling/WordRaceScheduler.js";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import type { WordRoundEndedPayload, WordRoundStartedPayload } from "../src/infrastructure/ws/events.js";
import {
  registerSocketHandlers,
  type BattleServer,
  type SocketDependencies,
  type SocketHandlersHandle,
} from "../src/infrastructure/ws/socketHandlers.js";
import { createSocketWordRaceBroadcaster } from "../src/infrastructure/ws/wordRaceMessages.js";
import { trustClaimedPlayerId } from "./support/auth.js";
import { pickSong, readyUp } from "./support/ready.js";

/**
 * REN-1 / DIS-1: two battle-service instances that share nothing but Redis.
 * Players of the same room are split between them, and the room must behave as
 * if there were one server: shared state, broadcasts that cross instances, one
 * winner per word round, scores counted once.
 *
 * Runs only when TEST_REDIS_URL points to a disposable Redis
 * (e.g. `docker run --rm -p 6379:6379 redis:7`).
 */
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const OFFSETS_MS = [100, 1400, 2700];
const WINDOW_MS = 1000;

type AckResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
type SubmitAck = { outcome: string; winnerId: string | null };

interface Replica {
  name: string;
  url: string;
  io: BattleServer;
  http: HttpServer;
  handlers: SocketHandlersHandle;
  scheduler: WordRaceScheduler;
  stores: StateStores;
  /** Killed by the test (see kill); `after` must not close it again. */
  dead: boolean;
}

interface Recorded {
  replica: Replica;
  socket: ClientSocket;
  playerId: string;
  started: WordRoundStartedPayload[];
  ended: WordRoundEndedPayload[];
  updates: RoomDto[];
  chats: Array<{ senderId: string; content: string }>;
  battleStarted: number;
}

const adapterKey = `test-${randomUUID().slice(0, 8)}`;
const replicas: Replica[] = [];
const clients: ClientSocket[] = [];
const codes: string[] = [];
/** Extra Redis connections opened by tests (outbox), closed in `after`. */
const extraConnections: Redis[] = [];
const outboxNamespace = `test-outbox-${randomUUID().slice(0, 8)}`;

async function startReplica(name: string, extra: Partial<SocketDependencies> = {}): Promise<Replica> {
  const stores = createStateStores({ url: TEST_REDIS_URL!, ttlSeconds: 300, maxUpdateAttempts: 25, adapterKey, adapterRequestsTimeoutMs: 1_500 });
  const { rooms, wordRaces: races } = stores;
  const http = createServer();
  const io: BattleServer = new Server(http, { path: "/socket.io" });
  stores.attachAdapter(io);
  const scheduler = new WordRaceScheduler({
    startWordRace: new StartWordRace(rooms, races, { offsetsMs: OFFSETS_MS, windowMs: WINDOW_MS }),
    openWordRound: new OpenWordRound(rooms, races),
    expireWordRound: new ExpireWordRound(races),
    stopWordRace: new StopWordRace(races),
    resumeWordRace: new ResumeWordRace(rooms, races),
    broadcaster: createSocketWordRaceBroadcaster(io),
  });
  const handlers = registerSocketHandlers(io, {
    authenticateHandshake: trustClaimedPlayerId,
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
    disconnectGraceMs: 50,
    ...extra,
    wordRace: {
      scheduler,
      submitWord: new SubmitWord(races),
      awardWordBonus: new AwardWordBonus(rooms),
      getActiveWordRound: new GetActiveWordRound(races),
    },
  });
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const url = `http://localhost:${(http.address() as AddressInfo).port}`;
  const replica: Replica = { name, url, io, http, handlers, scheduler, stores, dead: false };
  replicas.push(replica);
  return replica;
}

function emit<T>(socket: ClientSocket, event: string, payload: unknown): Promise<AckResponse<T>> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function ok<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  const response = await emit<T>(socket, event, payload);
  if (!response.ok) assert.fail(`${event} failed: ${response.error.code} ${response.error.message}`);
  return response.data;
}

/**
 * DIS-1: the replica stops abruptly. Its clients lose their connection, every
 * timer it owned (word race, deadlines, grace periods) is gone, and its Redis
 * connections close, so it no longer answers adapter requests. Nothing it
 * stored is cleaned up: the race and the room stay in Redis, as after a crash.
 */
async function kill(replica: Replica): Promise<void> {
  replica.dead = true;
  await replica.io.close();
  // The disconnects above armed grace timers on this replica; a dead process has none.
  replica.handlers.close();
  replica.scheduler.close();
  await replica.stores.close();
}

/** Brings a room with two dancers and two spectators to a running battle, started by `host`. */
async function battleOn(owner: Replica, seats: Array<[Replica, string, "dancer" | "spectator"]>): Promise<{ code: string; players: Recorded[] }> {
  const [, hostId] = seats[0];
  const created = await new CreateRoom(owner.stores.rooms).execute({ hostId, displayName: hostId });
  codes.push(created.code);
  const players: Recorded[] = [];
  for (const [replica, playerId] of seats) players.push(await client(replica, playerId));
  for (const p of players) await ok(p.socket, "room:join", { roomCode: created.code, playerId: p.playerId, displayName: p.playerId });
  for (const [i, [, playerId, role]] of seats.entries()) await ok(players[i].socket, "role:select", { roomCode: created.code, playerId, role });
  await readyUp(created.code, Object.fromEntries(players.map((p) => [p.playerId, p.socket])));
  await pickSong(owner.stores.rooms, created.code);
  await ok(players[0].socket, "battle:start", { roomCode: created.code, requesterId: hostId });
  return { code: created.code, players };
}

/** The history of every replica of the test goes to this outbox in Redis, like production. */
function recorder(publisher: MatchResultPublisher): RecordMatchResult {
  const connection = new Redis(TEST_REDIS_URL!);
  extraConnections.push(connection);
  const outbox = new RedisMatchOutbox(connection, { deliveredRetentionSeconds: 300, namespace: outboxNamespace });
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  return new RecordMatchResult(publisher, { outbox, redeliveryBaseMs: 0, logger: quiet });
}

/** users-service as each replica sees it: `hang` never answers (the replica dies mid-request). */
function historyStore(hang: boolean): MatchResultPublisher & { calls: MatchRecord[] } {
  const calls: MatchRecord[] = [];
  return {
    calls,
    publish(match) {
      calls.push(match);
      return hang ? new Promise<void>(() => undefined) : Promise.resolve();
    },
  };
}

function endsOf(rec: Recorded, roundId: string): number {
  return rec.ended.filter((e) => e.roundId === roundId).length;
}

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await sleep(5);
  }
}

async function client(replica: Replica, playerId: string): Promise<Recorded> {
  const socket = connect(replica.url, { path: "/socket.io", transports: ["websocket"], forceNew: true });
  clients.push(socket);
  const rec: Recorded = { replica, socket, playerId, started: [], ended: [], updates: [], chats: [], battleStarted: 0 };
  socket.on("word:round-started", (p: WordRoundStartedPayload) => rec.started.push(p));
  socket.on("word:round-ended", (p: WordRoundEndedPayload) => rec.ended.push(p));
  socket.on("room:updated", (room: RoomDto) => rec.updates.push(room));
  socket.on("chat:message", (m: { senderId: string; content: string }) => rec.chats.push(m));
  socket.on("battle:started", () => (rec.battleStarted += 1));
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
  return rec;
}

describe("Two battle-service instances sharing one Redis", { skip: !TEST_REDIS_URL && "TEST_REDIS_URL is not set" }, () => {
  let one: Replica;
  let two: Replica;

  before(async () => {
    one = await startReplica("replica-1");
    two = await startReplica("replica-2");
  });

  after(async () => {
    for (const socket of clients) socket.disconnect();
    for (const replica of replicas) {
      if (replica.dead) continue;
      replica.handlers.close();
      replica.scheduler.close();
      await replica.io.close();
      await replica.stores.close();
    }
    if (extraConnections.length > 0) await extraConnections[0].del(`{${outboxNamespace}}:pending`, `{${outboxNamespace}}:delivered`);
    await Promise.allSettled(extraConnections.map((c) => c.quit()));
  });

  it("plays a whole battle with the players split between both instances", async () => {
    // The room is created through instance 1; dancers and spectators sit on both.
    const created = await new CreateRoom(one.stores.rooms).execute({ hostId: "host", displayName: "Host" });
    const code = created.code;
    codes.push(code);

    const host = await client(one, "host"); // dancer, instance 1 (runs the round timers)
    const guest = await client(two, "guest"); // dancer, instance 2
    const fanA = await client(one, "fanA");
    const fanB = await client(two, "fanB");
    const everyone = [host, guest, fanA, fanB];

    for (const p of everyone) await ok(p.socket, "room:join", { roomCode: code, playerId: p.playerId, displayName: p.playerId });
    await ok(host.socket, "role:select", { roomCode: code, playerId: "host", role: "dancer" });
    await ok(guest.socket, "role:select", { roomCode: code, playerId: "guest", role: "dancer" });
    await ok(fanA.socket, "role:select", { roomCode: code, playerId: "fanA", role: "spectator" });
    await ok(fanB.socket, "role:select", { roomCode: code, playerId: "fanB", role: "spectator" });

    // State written through one instance is read by the other.
    const seenByTwo = await two.stores.rooms.findByCode(code);
    assert.equal(seenByTwo?.players.length, 4);

    // io.in(room).fetchSockets() counts the sockets of every instance.
    assert.equal((await one.io.in(code).fetchSockets()).length, 4);
    assert.equal((await two.io.in(code).fetchSockets()).length, 4);

    await readyUp(code, Object.fromEntries(everyone.map((p) => [p.playerId, p.socket])));
    await pickSong(one.stores.rooms, code);
    await ok(host.socket, "battle:start", { roomCode: code, requesterId: "host" });

    // battle:started and the first word reach the four clients, whichever instance they are on.
    await waitUntil(() => everyone.every((p) => p.battleStarted === 1), "battle:started on every client");
    await waitUntil(() => everyone.every((p) => p.started.length >= 1), "round 1 on every client");
    const round1 = host.started[0];
    assert.ok(everyone.every((p) => p.started[0].roundId === round1.roundId && p.started[0].word === round1.word));

    // A chat message and a vote sent from instance 2 reach the spectator on instance 1.
    await ok(fanB.socket, "chat:message", { roomCode: code, senderId: "fanB", content: "hola desde la réplica 2" });
    await waitUntil(() => fanA.chats.some((m) => m.content === "hola desde la réplica 2"), "chat across instances");
    await ok(fanB.socket, "vote:cast", { roomCode: code, voterId: "fanB", dancerId: "host" });
    await waitUntil(() => fanA.updates.some((r) => r.battle?.voteCounts?.host === 1), "vote across instances");

    // Both dancers answer at the same instant, each on its own instance: one wins, once.
    const [hostAck, guestAck] = await Promise.all([
      emit<SubmitAck>(host.socket, "word:submit", { roomCode: code, playerId: "host", roundId: round1.roundId, text: round1.word }),
      emit<SubmitAck>(guest.socket, "word:submit", { roomCode: code, playerId: "guest", roundId: round1.roundId, text: round1.word }),
    ]);
    assert.ok(hostAck.ok && guestAck.ok);
    assert.deepEqual([hostAck.data.outcome, guestAck.data.outcome].sort(), ["late", "won"]);
    const winnerId = hostAck.data.outcome === "won" ? "host" : "guest";
    assert.equal(hostAck.data.winnerId, winnerId);
    assert.equal(guestAck.data.winnerId, winnerId);

    await waitUntil(() => everyone.every((p) => p.ended.some((e) => e.roundId === round1.roundId)), "round 1 end on every client");
    await sleep(WINDOW_MS + 100); // a duplicate announcement from an expiry timer would show up by now
    for (const p of everyone) {
      const ended = p.ended.filter((e) => e.roundId === round1.roundId);
      assert.equal(ended.length, 1, `${p.playerId} (${p.replica.name}) must see the end of the round exactly once`);
      assert.equal(ended[0].winnerId, winnerId);
      assert.equal(ended[0].reason, "won");
    }
    const stored = (await two.stores.rooms.findByCode(code))!;
    assert.equal(stored.battle?.wordsWon?.[winnerId], 1, "the win is scored once");
    assert.equal(Object.values(stored.battle?.wordsWon ?? {}).reduce((a, b) => a + b, 0), 1);

    // Round 2: the dancer on instance 2 wins it, although instance 1 owns the timers.
    await waitUntil(() => everyone.every((p) => p.started.length >= 2), "round 2 on every client");
    const round2 = guest.started[1];
    const win2 = await ok<SubmitAck>(guest.socket, "word:submit", { roomCode: code, playerId: "guest", roundId: round2.roundId, text: round2.word });
    assert.equal(win2.outcome, "won");
    await waitUntil(() => everyone.every((p) => p.ended.some((e) => e.roundId === round2.roundId)), "round 2 end on every client");

    // Round 3 is left alone: nobody types it and it expires, announced once.
    await waitUntil(() => everyone.every((p) => p.ended.some((e) => e.roundId === host.started[2]?.roundId)), "round 3 expiry", 6000);
    for (const p of everyone) {
      for (const round of host.started) {
        assert.equal(p.ended.filter((e) => e.roundId === round.roundId).length, 1, `round ${round.roundNumber} ended once for ${p.playerId}`);
      }
    }
    const finalRoom = (await one.stores.rooms.findByCode(code))!;
    const wins = Object.values(finalRoom.battle?.wordsWon ?? {}).reduce((a, b) => a + b, 0);
    assert.equal(wins, 2, "two rounds were won, one expired: two scored wins");
  });

  it("DIS-1: the word race goes on when the replica running its timers dies, each round announced once", async () => {
    const owner = await startReplica("owner");
    const survivor = await startReplica("survivor");
    const { code, players } = await battleOn(owner, [
      [owner, "k-host", "dancer"],
      [survivor, "k-guest", "dancer"],
      [owner, "k-fanA", "spectator"],
      [survivor, "k-fanB", "spectator"],
    ]);
    const [host, guest, fanA, fanB] = players;
    await waitUntil(() => players.every((p) => p.started.length >= 1), "round 1 on every client");
    const round1 = guest.started[0];

    await kill(owner);
    // The owner's clients reconnect through the load balancer to the survivor and repeat room:join.
    const host2 = await client(survivor, "k-host");
    const fanA2 = await client(survivor, "k-fanA");
    for (const p of [host2, fanA2]) await ok(p.socket, "room:join", { roomCode: code, playerId: p.playerId, displayName: p.playerId });
    assert.ok(host.socket.disconnected && fanA.socket.disconnected);

    // Round 2 opens on the survivor; the guest wins it there.
    await waitUntil(() => guest.started.length >= 2, "round 2 opened by the survivor");
    const round2 = guest.started[1];
    const win = await ok<SubmitAck>(guest.socket, "word:submit", { roomCode: code, playerId: "k-guest", roundId: round2.roundId, text: round2.word });
    assert.equal(win.outcome, "won");
    await waitUntil(() => guest.started.length >= 3 && endsOf(guest, guest.started[2].roundId) === 1, "round 3 expired", 6000);
    await sleep(WINDOW_MS); // a duplicate announcement would show up by now

    const roundIds = guest.started.map((r) => r.roundId);
    assert.equal(roundIds[0], round1.roundId);
    assert.equal(new Set(roundIds).size, 3, "three distinct rounds");
    for (const p of [guest, fanB]) {
      for (const roundId of roundIds) {
        assert.equal(p.started.filter((r) => r.roundId === roundId).length, 1, `${p.playerId} saw ${roundId} open once`);
        assert.equal(endsOf(p, roundId), 1, `${p.playerId} saw ${roundId} end once`);
      }
    }
    for (const p of [host2, fanA2]) {
      for (const roundId of roundIds.slice(1)) assert.equal(endsOf(p, roundId), 1, `${p.playerId} saw ${roundId} end once after rejoining`);
    }
    const stored = (await survivor.stores.rooms.findByCode(code))!;
    assert.deepEqual(stored.battle?.wordsWon, { "k-host": 0, "k-guest": 1 }, "the win scored once, nothing lost");
    assert.deepEqual(stored.battle?.wordRoundsAwarded, [round2.roundId]);
  });

  it("DIS-1: with nobody rejoining, the survivor's periodic sweep resumes the word race", async () => {
    const owner = await startReplica("owner-2");
    const survivor = await startReplica("survivor-2");
    const { players } = await battleOn(owner, [
      [owner, "w-host", "dancer"],
      [survivor, "w-guest", "dancer"],
    ]);
    const guest = players[1];
    await waitUntil(() => guest.started.length >= 1, "round 1 on the survivor's client");
    await kill(owner);
    await survivor.handlers.sweep();
    await waitUntil(() => guest.started.length >= 3 && endsOf(guest, guest.started[2].roundId) === 1, "every round ended", 6000);
    for (const round of guest.started) assert.equal(endsOf(guest, round.roundId), 1, `round ${round.roundNumber} ended once`);
  });

  it("DIS-1: a finished match whose finisher died before delivering it reaches the history through another replica, once", async () => {
    const finisherStore = historyStore(true);
    const survivorStore = historyStore(false);
    const finisher = await startReplica("finisher", { recordMatchResult: recorder(finisherStore) });
    const survivor = await startReplica("deliverer", { recordMatchResult: recorder(survivorStore) });
    const { code, players } = await battleOn(finisher, [
      [finisher, "o-host", "dancer"],
      [finisher, "o-guest", "dancer"],
      [survivor, "o-fan", "spectator"],
    ]);
    // A dancer leaves: two dancers are not enough, the battle finishes on the finisher...
    await ok(players[1].socket, "room:leave", { roomCode: code, playerId: "o-guest" });
    const battleId = (await survivor.stores.rooms.findByCode(code))!.battle!.id;
    await waitUntil(() => finisherStore.calls.length === 1, "the finisher sending the match");
    // ...which dies while users-service has not answered yet.
    await kill(finisher);
    // Other suites may share this Redis: their finished rooms are swept too, so count this battle only.
    const deliveries = () => survivorStore.calls.filter((m) => m.id === battleId).length;
    assert.equal(deliveries(), 0);

    await survivor.handlers.sweep();
    assert.equal(deliveries(), 1, "delivered by the survivor");
    await survivor.handlers.sweep();
    assert.equal(deliveries(), 1, "and only once");
  });

  it("DIS-1: a kick on one replica cuts off the kicked player's tabs on the other replica", async () => {
    const created = await new CreateRoom(one.stores.rooms).execute({ hostId: "x-host", displayName: "Host" });
    const code = created.code;
    codes.push(code);
    const host = await client(one, "x-host");
    const idle = await client(two, "x-idle");
    const kicked: unknown[] = [];
    idle.socket.on("room:kicked", (payload: unknown) => kicked.push(payload));
    for (const p of [host, idle]) await ok(p.socket, "room:join", { roomCode: code, playerId: p.playerId, displayName: p.playerId });

    await ok(host.socket, "player:kick", { roomCode: code, requesterId: "x-host", playerId: "x-idle" });
    await waitUntil(() => kicked.length === 1, "room:kicked on the other replica");
    assert.deepEqual(kicked[0], { roomCode: code });

    // The kicked tab can no longer act in the room...
    const refused = await emit(idle.socket, "chat:message", { roomCode: code, senderId: "x-idle", content: "still here?" });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.error.code, "PLAYER_NOT_IN_ROOM");
    // ...nor receive its events.
    await ok(host.socket, "chat:message", { roomCode: code, senderId: "x-host", content: "bye" });
    await waitUntil(() => host.chats.some((m) => m.content === "bye"), "the host's own message");
    await sleep(100);
    assert.equal(idle.chats.length, 0);
    assert.equal((await two.io.in(code).fetchSockets()).length, 1, "only the host is left in the room channel");
  });

  it("lets instance 2 join a room that instance 1 created", async () => {
    const created = await new CreateRoom(one.stores.rooms).execute({ hostId: "solo", displayName: "Solo" });
    codes.push(created.code);
    const survivor = await client(two, "viewer");
    await ok(survivor.socket, "room:join", { roomCode: created.code, playerId: "viewer", displayName: "Viewer" });
    const stored = await two.stores.rooms.findByCode(created.code);
    assert.equal(stored?.players.length, 2, "instance 2 sees the room that instance 1 created");
  });
});
