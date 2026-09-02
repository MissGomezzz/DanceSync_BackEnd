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
} from "./events.js";

export type BattleServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type BattleSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface SocketDependencies {
  joinRoom: JoinRoom;
  startBattle: StartBattle;
  sendChatMessage: SendChatMessage;
  rateDancer: RateDancer;
}

export function registerSocketHandlers(io: BattleServer, deps: SocketDependencies): void {
  io.on("connection", (socket) => {
    socket.on(ClientEvents.ROOM_JOIN, (payload, ack) =>
      guard(socket, ack, async () => {
        const room = await deps.joinRoom.execute(payload);
        socket.data.playerId = payload.playerId;
        socket.data.roomCode = room.code;
        await socket.join(room.code);
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

    socket.on("disconnect", async () => {
      const { playerId, roomCode } = socket.data;
      if (!playerId || !roomCode) return;
      try {
        const room = await deps.joinRoom.leave({ roomCode, playerId });
        if (room) io.to(room.code).emit(ServerEvents.ROOM_UPDATED, room);
      } catch (error) {
        // The room may already be gone; nothing to broadcast.
        if (!(error instanceof DomainError)) console.error("Error handling disconnect", error);
      }
    });
  });
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
