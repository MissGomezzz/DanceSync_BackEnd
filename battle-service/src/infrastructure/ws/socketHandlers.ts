import type { Server, Socket } from "socket.io";
import type { JoinRoom } from "../../application/usecases/JoinRoom.js";
import type { RateDancer } from "../../application/usecases/RateDancer.js";
import type { SendChatMessage } from "../../application/usecases/SendChatMessage.js";
import type { StartBattle } from "../../application/usecases/StartBattle.js";
import { DomainError } from "../../domain/errors/DomainError.js";
import {
  ClientEvents,
  ServerEvents,
  type Ack,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SocketData,
  type WebRtcSignalPayload,
} from "./events.js";

export type BattleServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type BattleSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface SocketDependencies {
  joinRoom: JoinRoom;
  startBattle: StartBattle;
  sendChatMessage: SendChatMessage;
  rateDancer: RateDancer;
  /** Seat retention after a disconnect, see env.disconnectGraceMs. */
  disconnectGraceMs: number;
}

export function registerSocketHandlers(io: BattleServer, deps: SocketDependencies): void {
  io.on("connection", (socket) => {
    socket.on(ClientEvents.ROOM_JOIN, (payload, ack) =>
      guard(socket, ack, async () => {
        const room = await deps.joinRoom.execute(payload);
        socket.data.playerId = payload.playerId;
        socket.data.roomCode = room.code;
        // The per-player channel lets WebRTC signaling target one player's sockets.
        await socket.join([room.code, playerChannel(payload.playerId)]);
        io.to(room.code).emit(ServerEvents.ROOM_UPDATED, room);
        return room;
      }),
    );

    socket.on(ClientEvents.ROOM_LEAVE, (payload, ack) =>
      guard(socket, ack, async () => {
        const room = await deps.joinRoom.leave(payload);
        await socket.leave(payload.roomCode);
        socket.data.roomCode = undefined;
        if (room) io.to(room.code).emit(ServerEvents.ROOM_UPDATED, room);
        return room;
      }),
    );

    socket.on(ClientEvents.BATTLE_START, (payload, ack) =>
      guard(socket, ack, async () => {
        const room = await deps.startBattle.execute(payload);
        io.to(room.code).emit(ServerEvents.BATTLE_STARTED, room);
        io.to(room.code).emit(ServerEvents.ROOM_UPDATED, room);
        return room;
      }),
    );

    socket.on(ClientEvents.CHAT_MESSAGE, (payload, ack) =>
      guard(socket, ack, async () => {
        const message = await deps.sendChatMessage.execute(payload);
        io.to(message.roomCode).emit(ServerEvents.CHAT_MESSAGE, message);
        return message;
      }),
    );

    socket.on(ClientEvents.RATING_SUBMIT, (payload, ack) =>
      guard(socket, ack, async () => {
        const { room, finished } = await deps.rateDancer.execute(payload);
        io.to(room.code).emit(ServerEvents.ROOM_UPDATED, room);
        if (finished) io.to(room.code).emit(ServerEvents.BATTLE_FINISHED, room);
        return room;
      }),
    );

    // WebRTC signaling is a thin relay: it checks room membership and forwards
    // opaque payloads. Media flows peer to peer and never reaches the server.
    socket.on(ClientEvents.WEBRTC_READY, (payload, ack) =>
      guard(socket, ack, async () => {
        const roomCode = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        socket.to(roomCode).emit(ServerEvents.WEBRTC_PEER_READY, { playerId: payload.playerId });
        return null;
      }),
    );

    socket.on(ClientEvents.WEBRTC_SIGNAL, (payload, ack) =>
      guard(socket, ack, async () => {
        const roomCode = requireOwnSeat(socket, payload?.roomCode, payload?.from);
        const signal = requireValidSignal(payload);
        const roomSockets = await io.in(roomCode).fetchSockets();
        if (!roomSockets.some((s) => s.data.playerId === signal.to)) {
          throw new DomainError("PLAYER_NOT_IN_ROOM", `Player ${signal.to} is not connected to room ${roomCode}`);
        }
        io.to(playerChannel(signal.to)).emit(ServerEvents.WEBRTC_SIGNAL, signal);
        return null;
      }),
    );

    socket.on("disconnect", () => {
      const { playerId, roomCode } = socket.data;
      if (!playerId || !roomCode) return;
      // A refresh or a transient network drop disconnects the socket too. Removing the
      // player immediately would delete a room whose only player is reloading the page,
      // so the seat is kept for a grace period and released only if nobody rejoined.
      setTimeout(() => void releaseSeatIfAbandoned(io, deps, roomCode, playerId), deps.disconnectGraceMs);
    });
  });
}

async function releaseSeatIfAbandoned(
  io: BattleServer,
  deps: SocketDependencies,
  roomCode: string,
  playerId: string,
): Promise<void> {
  try {
    const sockets = await io.in(roomCode).fetchSockets();
    if (sockets.some((s) => s.data.playerId === playerId)) return; // Player is back.
    const room = await deps.joinRoom.leave({ roomCode, playerId });
    if (room) io.to(room.code).emit(ServerEvents.ROOM_UPDATED, room);
  } catch (error) {
    // The player may have left explicitly or the room may already be gone.
    if (!(error instanceof DomainError)) console.error("Error releasing abandoned seat", error);
  }
}

function playerChannel(playerId: string): string {
  return `player:${playerId}`;
}

/**
 * Ensures the socket joined `roomCode` as `playerId`, so a client can neither
 * signal into a room it is not in nor impersonate another player.
 */
function requireOwnSeat(socket: BattleSocket, roomCode: unknown, playerId: unknown): string {
  const { roomCode: joinedRoom, playerId: joinedPlayer } = socket.data;
  if (!joinedRoom || !joinedPlayer || roomCode !== joinedRoom || playerId !== joinedPlayer) {
    throw new DomainError("PLAYER_NOT_IN_ROOM", "The socket has not joined this room as this player");
  }
  return joinedRoom;
}

/** Validates the relay-relevant fields and rebuilds the payload with only the known keys. */
function requireValidSignal(payload: WebRtcSignalPayload): WebRtcSignalPayload {
  const { roomCode, from, to, negotiationId, description, candidate } = payload;
  const hasDescription = typeof description === "object" && description !== null;
  const hasCandidate = typeof candidate === "object" && candidate !== null;
  if (
    !isNonEmptyString(to) ||
    to === from ||
    !isNonEmptyString(negotiationId) ||
    hasDescription === hasCandidate ||
    (hasDescription && typeof description.type !== "string")
  ) {
    throw new DomainError("INVALID_MESSAGE", "Invalid WebRTC signaling message");
  }
  return {
    roomCode,
    from,
    to,
    negotiationId,
    ...(hasDescription ? { description: { type: description.type, sdp: description.sdp } } : {}),
    ...(hasCandidate ? { candidate } : {}),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Runs a handler, replying through the ack callback when provided and emitting a
 * domain error event to the calling socket otherwise.
 */
async function guard<T>(socket: BattleSocket, ack: Ack<T> | undefined, handler: () => Promise<T>): Promise<void> {
  try {
    const data = await handler();
    ack?.({ ok: true, data });
  } catch (error) {
    const payload =
      error instanceof DomainError
        ? { code: error.code, message: error.message }
        : { code: "INTERNAL_ERROR", message: "Unexpected server error" };
    if (!(error instanceof DomainError)) console.error("Unhandled socket error", error);
    if (ack) ack({ ok: false, error: payload });
    else socket.emit(ServerEvents.ERROR, payload);
  }
}
