import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { ChooseSong } from "../../src/application/usecases/ChooseSong.js";
import { FinishBattleAtDeadline } from "../../src/application/usecases/FinishBattleAtDeadline.js";
import { KickPlayer } from "../../src/application/usecases/KickPlayer.js";
import { CreateRoom } from "../../src/application/usecases/CreateRoom.js";
import { JoinRoom } from "../../src/application/usecases/JoinRoom.js";
import { RateDancer } from "../../src/application/usecases/RateDancer.js";
import { SelectRole } from "../../src/application/usecases/SelectRole.js";
import { SetReady } from "../../src/application/usecases/SetReady.js";
import { SendChatMessage } from "../../src/application/usecases/SendChatMessage.js";
import { StartBattle } from "../../src/application/usecases/StartBattle.js";
import { StartSongChallenge, type SongChallengeOptions } from "../../src/application/usecases/StartSongChallenge.js";
import { SubmitSongPhrase } from "../../src/application/usecases/SubmitSongPhrase.js";
import { InMemoryRoomRepository } from "../../src/infrastructure/persistence/InMemoryRoomRepository.js";
import {
  registerSocketHandlers,
  type BattleServer,
  type SocketDependencies,
  type SocketHandlersHandle,
} from "../../src/infrastructure/ws/socketHandlers.js";

export type AckResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export interface HarnessOptions {
  disconnectGraceMs?: number;
  songChallenge?: SongChallengeOptions;
  /** Extra or replaced dependencies, built with the harness repository. */
  extend?: (rooms: InMemoryRoomRepository) => Partial<SocketDependencies>;
}

/** In-process battle-service (Socket.IO only) on a random port, plus client helpers. */
export class SocketHarness {
  readonly rooms = new InMemoryRoomRepository();
  readonly createRoom = new CreateRoom(this.rooms);
  private httpServer!: HttpServer;
  io!: BattleServer;
  private url = "";
  private readonly clients: ClientSocket[] = [];
  private handle: SocketHandlersHandle | undefined;

  async start(options: HarnessOptions = {}): Promise<this> {
    this.httpServer = createServer();
    this.io = new Server(this.httpServer, { path: "/socket.io" });
    this.handle = registerSocketHandlers(this.io, {
      joinRoom: new JoinRoom(this.rooms),
      startBattle: new StartBattle(this.rooms),
      selectRole: new SelectRole(this.rooms),
      setReady: new SetReady(this.rooms),
      sendChatMessage: new SendChatMessage(this.rooms),
      rateDancer: new RateDancer(this.rooms),
      startSongChallenge: new StartSongChallenge(this.rooms, options.songChallenge),
      submitSongPhrase: new SubmitSongPhrase(this.rooms),
      chooseSong: new ChooseSong(this.rooms),
      finishBattleAtDeadline: new FinishBattleAtDeadline(this.rooms),
      kickPlayer: new KickPlayer(this.rooms),
      disconnectGraceMs: options.disconnectGraceMs ?? 50,
      ...options.extend?.(this.rooms),
    });
    await new Promise<void>((resolve) => this.httpServer.listen(0, resolve));
    this.url = `http://localhost:${(this.httpServer.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    for (const socket of this.clients) socket.disconnect();
    this.handle?.close();
    await this.io.close();
  }

  async client(): Promise<ClientSocket> {
    const socket = connect(this.url, { path: "/socket.io", transports: ["websocket"], forceNew: true });
    this.clients.push(socket);
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    return socket;
  }

  /** Deadline timers owned by the socket handlers. */
  roomTimers() {
    assert.ok(this.handle, "the harness is not started");
    return this.handle.roomTimers;
  }

  async storedRoom(code: string) {
    const room = await this.rooms.findByCode(code);
    assert.ok(room, `room ${code} should exist`);
    return room;
  }
}

export function emit<T>(socket: ClientSocket, event: string, ...args: unknown[]): Promise<AckResponse<T>> {
  return new Promise((resolve) => socket.emit(event, ...args, resolve));
}

export async function ok<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  const response = await emit<T>(socket, event, payload);
  if (!response.ok) assert.fail(`${event} failed: ${response.error.code} ${response.error.message}`);
  return response.data;
}

export async function rejected(socket: ClientSocket, event: string, payload: unknown, code: string): Promise<void> {
  const response = await emit(socket, event, payload);
  assert.equal(response.ok, false, `${event} should have been rejected`);
  assert.equal(!response.ok && response.error.code, code);
}

export async function waitUntil(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await sleep(5);
  }
}

/** Records every payload of `event` received by `socket`. */
export function record<T>(socket: ClientSocket, event: string): T[] {
  const seen: T[] = [];
  socket.on(event, (payload: T) => seen.push(payload));
  return seen;
}
