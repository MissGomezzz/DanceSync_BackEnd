import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { ChooseSong } from "../src/application/usecases/ChooseSong.js";
import { FinishBattleAtDeadline } from "../src/application/usecases/FinishBattleAtDeadline.js";
import { KickPlayer } from "../src/application/usecases/KickPlayer.js";
import { ReapRooms } from "../src/application/usecases/ReapRooms.js";
import { CreateRoom } from "../src/application/usecases/CreateRoom.js";
import { JoinRoom } from "../src/application/usecases/JoinRoom.js";
import { CastVote } from "../src/application/usecases/CastVote.js";
import { StartRematch } from "../src/application/usecases/StartRematch.js";
import { SelectRole } from "../src/application/usecases/SelectRole.js";
import { SetReady } from "../src/application/usecases/SetReady.js";
import { SendChatMessage } from "../src/application/usecases/SendChatMessage.js";
import { StartBattle } from "../src/application/usecases/StartBattle.js";
import { StartSongChallenge } from "../src/application/usecases/StartSongChallenge.js";
import { SubmitSongPhrase } from "../src/application/usecases/SubmitSongPhrase.js";
import type { ChatMessage } from "../src/domain/model/ChatMessage.js";
import type { Room } from "../src/domain/model/Room.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";
import { registerSocketHandlers, type BattleServer, type SocketHandlersHandle } from "../src/infrastructure/ws/socketHandlers.js";
import { pickSong, readyUp } from "./support/ready.js";

type AckResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

let httpServer: HttpServer;
let io: BattleServer;
let handlers: SocketHandlersHandle;
let url: string;
let rooms: InMemoryRoomRepository;
let createRoom: CreateRoom;
const clients: ClientSocket[] = [];

function emit<T>(socket: ClientSocket, event: string, payload: unknown): Promise<AckResponse<T>> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function ok<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  const response = await emit<T>(socket, event, payload);
  if (!response.ok) assert.fail(`${event} failed: ${response.error.code} ${response.error.message}`);
  return response.data;
}

async function rejected(socket: ClientSocket, event: string, payload: unknown, code: string): Promise<void> {
  const response = await emit(socket, event, payload);
  assert.equal(response.ok, false, `${event} should have been rejected`);
  assert.equal(!response.ok && response.error.code, code);
}

async function client(): Promise<ClientSocket> {
  const socket = connect(url, { path: "/socket.io", transports: ["websocket"], forceNew: true });
  clients.push(socket);
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
  return socket;
}

async function storedRoom(code: string): Promise<Room> {
  const room = await rooms.findByCode(code);
  assert.ok(room, `room ${code} should exist`);
  return room;
}

/** Lobby with `host` (room host), `guest` and `fan`, each joined on its own socket; nobody chose a role yet. */
async function lobby(): Promise<{ code: string; host: ClientSocket; guest: ClientSocket; fan: ClientSocket }> {
  const created = await createRoom.execute({ hostId: "host", displayName: "Host" });
  const code = created.code;
  const host = await client();
  const guest = await client();
  const fan = await client();
  await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
  await ok(guest, "room:join", { roomCode: code, playerId: "guest", displayName: "Guest" });
  await ok(fan, "room:join", { roomCode: code, playerId: "fan", displayName: "Fan" });
  return { code, host, guest, fan };
}

/** Same lobby with host and guest as dancers and fan as spectator, battle running. */
async function battle(): Promise<{ code: string; host: ClientSocket; guest: ClientSocket; fan: ClientSocket }> {
  const room = await lobby();
  await ok(room.host, "role:select", { roomCode: room.code, playerId: "host", role: "dancer" });
  await ok(room.guest, "role:select", { roomCode: room.code, playerId: "guest", role: "dancer" });
  await ok(room.fan, "role:select", { roomCode: room.code, playerId: "fan", role: "spectator" });
  await readyUp(room.code, { host: room.host, guest: room.guest, fan: room.fan });
  await pickSong(rooms, room.code);
  await ok(room.host, "battle:start", { roomCode: room.code, requesterId: "host" });
  return room;
}

before(async () => {
  rooms = new InMemoryRoomRepository();
  createRoom = new CreateRoom(rooms);
  httpServer = createServer();
  io = new Server(httpServer, { path: "/socket.io" });
  handlers = registerSocketHandlers(io, {
    joinRoom: new JoinRoom(rooms),
    startBattle: new StartBattle(rooms),
    selectRole: new SelectRole(rooms),
    setReady: new SetReady(rooms),
    sendChatMessage: new SendChatMessage(rooms),
    castVote: new CastVote(rooms),
    startRematch: new StartRematch(rooms),
    startSongChallenge: new StartSongChallenge(rooms, { durationMs: 300 }),
    submitSongPhrase: new SubmitSongPhrase(rooms),
    chooseSong: new ChooseSong(rooms),
    finishBattleAtDeadline: new FinishBattleAtDeadline(rooms),
    kickPlayer: new KickPlayer(rooms),
    reapRooms: new ReapRooms(rooms),
    disconnectGraceMs: 50,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  for (const socket of clients) socket.disconnect();
  handlers.close();
  await io.close();
});

describe("Socket identity: every client event acts as the player bound by room:join", () => {
  it("room:leave cannot kick another player, but a player can leave", async () => {
    const { code, guest } = await lobby();
    await rejected(guest, "room:leave", { roomCode: code, playerId: "host" }, "PLAYER_NOT_IN_ROOM");
    assert.ok((await storedRoom(code)).players.some((p) => p.id === "host"), "the host was kicked");

    const room = await ok<Room | null>(guest, "room:leave", { roomCode: code, playerId: "guest" });
    assert.deepEqual(room?.players.map((p) => p.id), ["host", "fan"]);
  });

  it("role:select cannot change another player's role", async () => {
    const { code, guest } = await lobby();
    await rejected(guest, "role:select", { roomCode: code, playerId: "host", role: "spectator" }, "PLAYER_NOT_IN_ROOM");
    assert.equal((await storedRoom(code)).players.find((p) => p.id === "host")?.role, "undecided");

    const room = await ok<Room>(guest, "role:select", { roomCode: code, playerId: "guest", role: "dancer" });
    assert.equal(room.players.find((p) => p.id === "guest")?.role, "dancer");
  });

  it("battle:start cannot be sent as the host by someone else, and a real non-host gets NOT_HOST", async () => {
    const { code, host, guest, fan } = await lobby();
    await ok(host, "role:select", { roomCode: code, playerId: "host", role: "dancer" });
    await ok(guest, "role:select", { roomCode: code, playerId: "guest", role: "dancer" });
    await readyUp(code, { host, guest, fan });
    await pickSong(rooms, code);

    await rejected(guest, "battle:start", { roomCode: code, requesterId: "host" }, "PLAYER_NOT_IN_ROOM");
    await rejected(guest, "battle:start", { roomCode: code, requesterId: "guest" }, "NOT_HOST");
    assert.equal((await storedRoom(code)).status, "waiting");

    const room = await ok<Room>(host, "battle:start", { roomCode: code, requesterId: "host" });
    assert.equal(room.status, "battling");
  });

  it("song-challenge:start cannot be sent as the host by someone else", async () => {
    const { code, host, guest, fan } = await lobby();
    await ok(host, "role:select", { roomCode: code, playerId: "host", role: "dancer" });
    await ok(guest, "role:select", { roomCode: code, playerId: "guest", role: "dancer" });
    await readyUp(code, { host, guest, fan });

    await rejected(guest, "song-challenge:start", { roomCode: code, requesterId: "host" }, "PLAYER_NOT_IN_ROOM");
    assert.equal((await storedRoom(code)).songSelection, null);

    const room = await ok<Room>(host, "song-challenge:start", { roomCode: code, requesterId: "host" });
    assert.equal(room.songSelection?.phase, "typing");
  });

  it("chat:message cannot be sent under another player's name", async () => {
    const { code, fan } = await lobby();
    await rejected(fan, "chat:message", { roomCode: code, senderId: "host", content: "I am the host" }, "PLAYER_NOT_IN_ROOM");

    const message = await ok<ChatMessage>(fan, "chat:message", { roomCode: code, senderId: "fan", content: "hello" });
    assert.equal(message.senderId, "fan");
    assert.equal(message.senderName, "Fan");
  });

  it("vote:cast cannot vote on behalf of a spectator", async () => {
    const { code, guest, fan } = await battle();
    // A dancer impersonating the spectator to boost themselves.
    await rejected(guest, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "guest" }, "PLAYER_NOT_IN_ROOM");
    assert.deepEqual((await storedRoom(code)).battle?.votes, {});

    const vote = await ok<{ dancerId: string | null }>(fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "guest" });
    assert.deepEqual(vote, { dancerId: "guest" });
    assert.deepEqual((await storedRoom(code)).battle?.votes, { fan: "guest" });
  });

  it("a socket cannot act in a room it did not join, even with a real player id", async () => {
    const { code } = await lobby();
    const outsider = await client();
    await rejected(outsider, "chat:message", { roomCode: code, senderId: "host", content: "hi" }, "PLAYER_NOT_IN_ROOM");
    await rejected(outsider, "room:leave", { roomCode: code, playerId: "guest" }, "PLAYER_NOT_IN_ROOM");

    // Joined elsewhere: its seat does not grant anything in this room.
    const other = await createRoom.execute({ hostId: "intruder", displayName: "Intruder" });
    await ok(outsider, "room:join", { roomCode: other.code, playerId: "intruder", displayName: "Intruder" });
    await rejected(outsider, "chat:message", { roomCode: code, senderId: "intruder", content: "hi" }, "PLAYER_NOT_IN_ROOM");
    assert.equal((await storedRoom(code)).players.length, 3);
  });
});
