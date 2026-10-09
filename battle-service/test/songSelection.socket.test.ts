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
import type { Room } from "../src/domain/model/Room.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";
import { registerSocketHandlers, type BattleServer, type SocketHandlersHandle } from "../src/infrastructure/ws/socketHandlers.js";
import { readyUp } from "./support/ready.js";

const PHRASE = "dale play";
const CHALLENGE_MS = 400;

type AckResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
/** Rooms travel as JSON, so dates arrive as strings. */
type WireRoom = Omit<Room, "songSelection"> & { songSelection: (Omit<NonNullable<Room["songSelection"]>, "challenge"> & { challenge: { id: string; phrase: string; expiresAt: string } }) | null };

let httpServer: HttpServer;
let io: BattleServer;
let handlers: SocketHandlersHandle;
let url: string;
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

function nextRoomUpdate(socket: ClientSocket, predicate: (room: WireRoom) => boolean): Promise<WireRoom> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for room:updated")), 3000);
    const listener = (room: WireRoom) => {
      if (!predicate(room)) return;
      clearTimeout(timer);
      socket.off("room:updated", listener);
      resolve(room);
    };
    socket.on("room:updated", listener);
  });
}

async function client(): Promise<ClientSocket> {
  const socket = connect(url, { path: "/socket.io", transports: ["websocket"], forceNew: true });
  clients.push(socket);
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
  return socket;
}

/** Room with two dancers: `host` (also the room host) and `guest`. */
async function lobbyWithTwoDancers(): Promise<{ code: string; host: ClientSocket; guest: ClientSocket }> {
  const created = await createRoom.execute({ hostId: "host", displayName: "Host" });
  const host = await client();
  const guest = await client();
  await ok(host, "room:join", { roomCode: created.code, playerId: "host", displayName: "Host" });
  await ok(guest, "room:join", { roomCode: created.code, playerId: "guest", displayName: "Guest" });
  await ok(host, "role:select", { roomCode: created.code, playerId: "host", role: "dancer" });
  await ok(guest, "role:select", { roomCode: created.code, playerId: "guest", role: "dancer" });
  await readyUp(created.code, { host, guest });
  return { code: created.code, host, guest };
}

before(async () => {
  const rooms = new InMemoryRoomRepository();
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
    startSongChallenge: new StartSongChallenge(rooms, { durationMs: CHALLENGE_MS, phrases: [PHRASE] }),
    submitSongPhrase: new SubmitSongPhrase(rooms, () => 0),
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

describe("Selección de canción por Socket.IO", () => {
  it("todos los jugadores de la sala reciben la frase y el temporizador al iniciar", async () => {
    const { code, host, guest } = await lobbyWithTwoDancers();
    const guestSees = nextRoomUpdate(guest, (r) => r.songSelection?.phase === "typing");
    const room = await ok<WireRoom>(host, "song-challenge:start", { roomCode: code, requesterId: "host" });
    const seen = await guestSees;
    assert.equal(seen.songSelection!.challenge.phrase, PHRASE);
    assert.equal(seen.songSelection!.challenge.expiresAt, room.songSelection!.challenge.expiresAt);
    assert.deepEqual(seen.songSelection!.participantIds, ["host", "guest"]);
  });

  it("solo el anfitrión puede iniciar el reto", async () => {
    const { code, guest } = await lobbyWithTwoDancers();
    const response = await emit(guest, "song-challenge:start", { roomCode: code, requesterId: "guest" });
    assert.equal(!response.ok && response.error.code, "NOT_HOST");
  });

  it("rechaza la frase mal escrita, acepta la correcta y el ganador elige la canción", async () => {
    const { code, host, guest } = await lobbyWithTwoDancers();
    await ok(host, "song-challenge:start", { roomCode: code, requesterId: "host" });

    const wrong = await ok<{ outcome: string }>(host, "song-challenge:submit", { roomCode: code, playerId: "host", text: "dale pley" });
    assert.equal(wrong.outcome, "incorrect");

    const hostSeesWinner = nextRoomUpdate(host, (r) => r.songSelection?.phase === "choosing");
    const right = await ok<{ outcome: string; room: WireRoom }>(guest, "song-challenge:submit", { roomCode: code, playerId: "guest", text: PHRASE });
    assert.equal(right.outcome, "accepted");
    assert.equal((await hostSeesWinner).songSelection!.chooserId, "guest");

    const notChooser = await emit(host, "song:choose", { roomCode: code, playerId: "host", songId: "song-1" });
    assert.equal(notChooser.ok, false);
    assert.equal(!notChooser.ok && notChooser.error.code, "NOT_SONG_CHOOSER");

    // Choosing the song is the last step of the lobby flow: it starts the battle.
    const hostSeesBattle = nextRoomUpdate(host, (r) => r.status === "battling");
    const chosen = await ok<WireRoom>(guest, "song:choose", { roomCode: code, playerId: "guest", songId: "song-3" });
    assert.equal(chosen.selectedSong?.id, "song-3");
    assert.equal(chosen.songSelection!.phase, "done");
    assert.equal(chosen.status, "battling");
    assert.equal(chosen.battle?.song?.id, "song-3");
    assert.equal((await hostSeesBattle).battle?.song?.id, "song-3");
  });

  it("cuando el temporizador llega a cero el servidor pasa el turno con la lógica predefinida", async () => {
    const { code, host, guest } = await lobbyWithTwoDancers();
    await ok(host, "song-challenge:start", { roomCode: code, requesterId: "host" });
    await ok(host, "song-challenge:submit", { roomCode: code, playerId: "host", text: "otra cosa" });

    const resolved = await nextRoomUpdate(guest, (r) => r.songSelection?.phase === "choosing");
    assert.equal(resolved.songSelection!.chooserReason, "timeout");
    // The host misspelled, so the fallback passes the turn to the other dancer.
    assert.equal(resolved.songSelection!.chooserId, "guest");

    const late = await emit(host, "song-challenge:submit", { roomCode: code, playerId: "host", text: PHRASE });
    assert.equal(!late.ok && late.error.code, "SONG_SELECTION_NOT_ACTIVE");
  });

  it("un jugador no puede enviar la frase haciéndose pasar por otro", async () => {
    const { code, host, guest } = await lobbyWithTwoDancers();
    await ok(host, "song-challenge:start", { roomCode: code, requesterId: "host" });
    const response = await emit(guest, "song-challenge:submit", { roomCode: code, playerId: "host", text: PHRASE });
    assert.equal(!response.ok && response.error.code, "PLAYER_NOT_IN_ROOM");
  });
});
