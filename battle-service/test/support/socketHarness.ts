import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import express from "express";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { ChooseSong } from "../../src/application/usecases/ChooseSong.js";
import { FinishBattleAtDeadline } from "../../src/application/usecases/FinishBattleAtDeadline.js";
import { KickPlayer } from "../../src/application/usecases/KickPlayer.js";
import { ReapRooms } from "../../src/application/usecases/ReapRooms.js";
import type { GuestTokenIssuer, TokenVerifier } from "../../src/application/auth/AuthIdentity.js";
import { CreateRoom } from "../../src/application/usecases/CreateRoom.js";
import { IssueGuestToken } from "../../src/application/usecases/IssueGuestToken.js";
import type { AuthAuditLog } from "../../src/infrastructure/auth/authAudit.js";
import { createHandshakeAuth } from "../../src/infrastructure/ws/handshakeAuth.js";
import { silentAudit, stubTokenVerifier, trustClaimedPlayerId } from "./auth.js";
import { JoinRoom } from "../../src/application/usecases/JoinRoom.js";
import { CastVote } from "../../src/application/usecases/CastVote.js";
import { StartRematch } from "../../src/application/usecases/StartRematch.js";
import { SelectRole } from "../../src/application/usecases/SelectRole.js";
import { SetReady } from "../../src/application/usecases/SetReady.js";
import { SendChatMessage } from "../../src/application/usecases/SendChatMessage.js";
import { StartBattle } from "../../src/application/usecases/StartBattle.js";
import { StartSongChallenge, type SongChallengeOptions } from "../../src/application/usecases/StartSongChallenge.js";
import { SubmitSongPhrase } from "../../src/application/usecases/SubmitSongPhrase.js";
import { buildRouter, errorHandler } from "../../src/infrastructure/http/routes.js";
import { InMemoryRoomRepository } from "../../src/infrastructure/persistence/InMemoryRoomRepository.js";
import {
  registerSocketHandlers,
  type BattleServer,
  type ReapingOptions,
  type SocketDependencies,
  type SocketHandlersHandle,
} from "../../src/infrastructure/ws/socketHandlers.js";

export type AckResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/** Real token validation, as in production (SEG-1 suites). */
export interface HarnessAuth {
  verifier: TokenVerifier;
  audit?: AuthAuditLog;
  /** Enables POST /api/rooms/:code/guest-token. */
  guestIssuer?: GuestTokenIssuer;
}

export interface HarnessOptions {
  /**
   * Validates handshakes and HTTP requests with this verifier. Omitted (suites
   * that are not about authentication): sockets act as the player they name in
   * room:join and HTTP accepts the stub tokens of support/auth.ts.
   */
  auth?: HarnessAuth;
  disconnectGraceMs?: number;
  pagehideGraceMs?: number;
  reaping?: ReapingOptions;
  songChallenge?: SongChallengeOptions;
  /** Extra or replaced dependencies, built with the harness repository. */
  extend?: (rooms: InMemoryRoomRepository) => Partial<SocketDependencies>;
}

/** In-process battle-service (Socket.IO plus the HTTP routes) on a random port, plus client helpers. */
export class SocketHarness {
  readonly rooms = new InMemoryRoomRepository();
  readonly createRoom = new CreateRoom(this.rooms);
  private httpServer!: HttpServer;
  io!: BattleServer;
  private url = "";
  private readonly clients: ClientSocket[] = [];
  private handle: SocketHandlersHandle | undefined;

  async start(options: HarnessOptions = {}): Promise<this> {
    const app = express();
    app.use(express.json());
    this.httpServer = createServer(app);
    this.io = new Server(this.httpServer, { path: "/socket.io" });
    const audit = options.auth?.audit ?? silentAudit;
    this.handle = registerSocketHandlers(this.io, {
      authenticateHandshake: options.auth
        ? createHandshakeAuth({ verifier: options.auth.verifier, audit })
        : trustClaimedPlayerId,
      authAudit: audit,
      joinRoom: new JoinRoom(this.rooms),
      startBattle: new StartBattle(this.rooms),
      selectRole: new SelectRole(this.rooms),
      setReady: new SetReady(this.rooms),
      sendChatMessage: new SendChatMessage(this.rooms),
      castVote: new CastVote(this.rooms),
      startRematch: new StartRematch(this.rooms),
      startSongChallenge: new StartSongChallenge(this.rooms, options.songChallenge),
      submitSongPhrase: new SubmitSongPhrase(this.rooms),
      chooseSong: new ChooseSong(this.rooms),
      finishBattleAtDeadline: new FinishBattleAtDeadline(this.rooms),
      kickPlayer: new KickPlayer(this.rooms),
      reapRooms: new ReapRooms(this.rooms),
      disconnectGraceMs: options.disconnectGraceMs ?? 50,
      pagehideGraceMs: options.pagehideGraceMs,
      reaping: options.reaping,
      ...options.extend?.(this.rooms),
    });
    const handle = this.handle;
    app.use(
      buildRouter({
        auth: { verifier: options.auth?.verifier ?? stubTokenVerifier, audit },
        ...(options.auth?.guestIssuer
          ? { issueGuestToken: new IssueGuestToken(this.rooms, options.auth.guestIssuer) }
          : {}),
        createRoom: this.createRoom,
        rooms: this.rooms,
        leaveRoom: (roomCode, playerId) => handle.leave(roomCode, playerId),
        leaveAfterPagehide: (roomCode, playerId) => handle.leaveAfterPagehide(roomCode, playerId),
      }),
    );
    app.use(errorHandler);
    await new Promise<void>((resolve) => this.httpServer.listen(0, resolve));
    this.url = `http://localhost:${(this.httpServer.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    for (const socket of this.clients) socket.disconnect();
    this.handle?.close();
    await this.io.close();
  }

  /** Base URL of the HTTP routes, e.g. for POST /api/rooms/:code/leave. */
  get baseUrl(): string {
    return this.url;
  }

  /** A connected client; `token` travels in the handshake like the frontend sends it. */
  async client(token?: string): Promise<ClientSocket> {
    const socket = this.open(token === undefined ? undefined : { token });
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => resolve());
      socket.on("connect_error", (error) => reject(new Error(`The handshake was refused: ${error.message}`)));
    });
    return socket;
  }

  /** Opens a connection that must be refused and resolves with the client's connect_error. */
  async refusedClient(
    auth?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<{ error: Error & { data?: unknown }; socket: ClientSocket }> {
    const socket = this.open(auth, extraHeaders);
    const error = await new Promise<Error & { data?: unknown }>((resolve, reject) => {
      socket.on("connect_error", (refusal) => resolve(refusal));
      socket.on("connect", () => reject(new Error("The handshake should have been refused")));
    });
    return { error, socket };
  }

  private open(auth?: Record<string, unknown>, extraHeaders?: Record<string, string>): ClientSocket {
    const socket = connect(this.url, {
      path: "/socket.io",
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      ...(auth ? { auth } : {}),
      ...(extraHeaders ? { extraHeaders } : {}),
    });
    this.clients.push(socket);
    return socket;
  }

  /** Deadline timers owned by the socket handlers. */
  roomTimers() {
    return this.handlers().roomTimers;
  }

  handlers(): SocketHandlersHandle {
    assert.ok(this.handle, "the harness is not started");
    return this.handle;
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
