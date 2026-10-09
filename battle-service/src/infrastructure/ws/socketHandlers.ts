import type { Server, Socket } from "socket.io";
import type { JoinRoom, LeaveRoomOutput } from "../../application/usecases/JoinRoom.js";
import type { KickPlayer } from "../../application/usecases/KickPlayer.js";
import type { RateDancer } from "../../application/usecases/RateDancer.js";
import type { SendChatMessage } from "../../application/usecases/SendChatMessage.js";
import type { StartBattle } from "../../application/usecases/StartBattle.js";
import type { SelectRole } from "../../application/usecases/SelectRole.js";
import type { SetReady } from "../../application/usecases/SetReady.js";
import type { ChooseSong } from "../../application/usecases/ChooseSong.js";
import type { FinishBattleAtDeadline } from "../../application/usecases/FinishBattleAtDeadline.js";
import type { StartSongChallenge } from "../../application/usecases/StartSongChallenge.js";
import type { SubmitSongPhrase } from "../../application/usecases/SubmitSongPhrase.js";
import type { GetActiveWordRound } from "../../application/usecases/GetActiveWordRound.js";
import type { AwardWordBonus } from "../../application/usecases/AwardWordBonus.js";
import type { SubmitWord } from "../../application/usecases/SubmitWord.js";
import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import { RoomTimers } from "../scheduling/RoomTimers.js";
import type { WordRaceScheduler } from "../scheduling/WordRaceScheduler.js";
import { toRoomDto, toRoomDtoOrNull } from "../serialization/roomDto.js";
import { roundEndedPayload, roundStartedPayload } from "./wordRaceMessages.js";
import {
  ClientEvents,
  ServerEvents,
  type Ack,
  type ClientToServerEvents,
  type RoomJoinPayload,
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
  selectRole: SelectRole;
  setReady: SetReady;
  startSongChallenge: StartSongChallenge;
  submitSongPhrase: SubmitSongPhrase;
  chooseSong: ChooseSong;
  kickPlayer: KickPlayer;
  /** Ends a battle still running at battle.endsAt (song clip plus rating grace). */
  finishBattleAtDeadline: FinishBattleAtDeadline;
  /** Seat retention after a disconnect, see env.disconnectGraceMs. */
  disconnectGraceMs: number;
  /** Mid-battle word race. Optional so harnesses that do not exercise it can omit it. */
  wordRace?: WordRaceSocketDependencies;
}

export interface WordRaceSocketDependencies {
  scheduler: WordRaceScheduler;
  submitWord: SubmitWord;
  awardWordBonus: AwardWordBonus;
  getActiveWordRound: GetActiveWordRound;
}

/** Lets the owner stop every timer the handlers own (tests, graceful shutdown). */
export interface SocketHandlersHandle {
  close(): void;
  /** Deadline timers per room (song challenge, ...), exposed so tests can prove nothing leaks. */
  readonly roomTimers: RoomTimers;
}

export function registerSocketHandlers(io: BattleServer, deps: SocketDependencies): SocketHandlersHandle {
  /**
   * Pending seat releases after a disconnect, one per (room, player). A newer
   * disconnect replaces the timer and a rejoin cancels it, so an old timer can
   * never release a seat that a later reconnect renewed.
   */
  const graceTimers = new Map<string, NodeJS.Timeout>();
  const roomTimers = new RoomTimers();

  /**
   * Single exit for every room:updated: serializes the room (relative times
   * computed now) and re-arms the room's deadline timers from the stored state,
   * so a deadline can never be left without a timer, whatever path changed it.
   */
  function publishRoom(room: Room): void {
    io.to(room.code).emit(ServerEvents.ROOM_UPDATED, toRoomDto(room, new Date()));
    armRoomTimers(room);
  }

  /** Derives the pending deadlines of a room from its state; anything not pending is cleared. */
  function armRoomTimers(room: Room): void {
    const selection = room.songSelection;
    if (room.status === "waiting" && selection?.phase === "typing") {
      const challengeId = selection.challenge.id;
      // The server owns the countdown: when it runs out the round is resolved
      // with the fallback rule even if no client submits anything.
      roomTimers.set(room.code, "song-challenge", selection.challenge.expiresAt, () =>
        expireSongChallenge(room.code, challengeId),
      );
    } else {
      roomTimers.clear(room.code, "song-challenge");
    }
    // The chooser's deadline. Re-armed on every publish, so it follows a turn
    // passed to another chooser, and an overdue deadline (whatever the reason the
    // timer did not run) is settled on the next publish of the room.
    if (room.status === "waiting" && selection?.phase === "choosing" && selection.chooseDeadline) {
      const challengeId = selection.challenge.id;
      roomTimers.set(room.code, "song-choose", selection.chooseDeadline, () => autoPickSong(room.code, challengeId));
    } else {
      roomTimers.clear(room.code, "song-choose");
    }
    // The automatic end of the battle: song clip plus rating grace.
    if (room.status === "battling" && room.battle) {
      const battleId = room.battle.id;
      roomTimers.set(room.code, "battle-end", room.battle.endsAt, () => finishBattleAtDeadline(room.code, battleId));
    } else {
      roomTimers.clear(room.code, "battle-end");
    }
  }

  async function finishBattleAtDeadline(roomCode: string, battleId: string): Promise<void> {
    const result = await deps.finishBattleAtDeadline.execute({ roomCode, battleId });
    if (!result) return; // Room gone.
    if (result.finished) await announceBattleFinished(result.room);
    // Fired a moment early: follow the stored state (re-arms only if still running).
    else armRoomTimers(result.room);
  }

  async function autoPickSong(roomCode: string, challengeId: string): Promise<void> {
    let result;
    try {
      result = await deps.chooseSong.autoPick({ roomCode, challengeId });
    } catch (error) {
      if (error instanceof DomainError && error.code === "ROOM_NOT_FOUND") return;
      throw error;
    }
    if (!result.picked) {
      // Fired a moment early, or for a turn that was renewed: follow the stored state.
      armRoomTimers(result.room);
      return;
    }
    if (result.battleStarted) announceBattleStarted(result.room);
    else publishRoom(result.room);
  }

  async function expireSongChallenge(roomCode: string, challengeId: string): Promise<void> {
    const room = await deps.startSongChallenge.expire({ roomCode, challengeId });
    if (room) publishRoom(room);
  }

  /** Single exit for every path that starts a battle: the host's start or the chosen song. */
  function announceBattleStarted(room: Room): void {
    io.to(room.code).emit(ServerEvents.BATTLE_STARTED, toRoomDto(room, new Date()));
    publishRoom(room);
    // The battle already started; a failure planning the word race must not undo it.
    deps.wordRace?.scheduler
      .start(room.code)
      .catch((error: unknown) => console.error("Error starting the word race", error));
  }

  /**
   * Single exit for every path that finishes a battle (last rating, leave,
   * released seat, deadline): room:updated, then battle:finished, then every
   * battle timer stops (publishRoom clears the battle-end deadline).
   */
  async function announceBattleFinished(room: Room): Promise<void> {
    publishRoom(room);
    io.to(room.code).emit(ServerEvents.BATTLE_FINISHED, toRoomDto(room, new Date()));
    await deps.wordRace?.scheduler.stop(room.code);
  }

  /**
   * Broadcasts the outcome of a departure (explicit room:leave or a seat released
   * after the disconnect grace period). The departure may have finished the
   * battle, which is announced like a battle finished by the last rating.
   */
  async function announceLeave(roomCode: string, { room, battleFinished }: LeaveRoomOutput): Promise<void> {
    if (!room) {
      // The last player left: the room is gone, and so is every timer it had.
      roomTimers.clearRoom(roomCode);
      await deps.wordRace?.scheduler.stop(roomCode);
      return;
    }
    if (battleFinished) {
      await announceBattleFinished(room);
      return;
    }
    publishRoom(room);
    if (room.status !== "battling") await deps.wordRace?.scheduler.stop(room.code);
  }

  function cancelGrace(roomCode: string, playerId: string): void {
    const key = seatKey(roomCode, playerId);
    clearTimeout(graceTimers.get(key));
    graceTimers.delete(key);
  }

  function scheduleGrace(roomCode: string, playerId: string): void {
    cancelGrace(roomCode, playerId);
    const key = seatKey(roomCode, playerId);
    const timer = setTimeout(() => {
      graceTimers.delete(key);
      void releaseSeatIfAbandoned(roomCode, playerId);
    }, deps.disconnectGraceMs);
    timer.unref();
    graceTimers.set(key, timer);
  }

  /**
   * Detaches every local socket bound to (roomCode, playerId): it leaves the room
   * and player channels and loses its binding, so a second tab of a player who
   * left can no longer act (requireOwnSeat fails) nor receive the room's events.
   */
  async function unbindPlayer(
    roomCode: string,
    playerId: string,
    beforeUnbind?: (socket: BattleSocket) => void,
  ): Promise<void> {
    for (const socket of io.of("/").sockets.values()) {
      const { roomCode: bound, playerId: boundPlayer } = socket.data;
      if (!bound || boundPlayer !== playerId || bound.toUpperCase() !== roomCode.toUpperCase()) continue;
      beforeUnbind?.(socket);
      await unbindSocket(socket);
    }
  }

  /** Single path for every departure: explicit leave, released seat or room switch. */
  async function leaveRoom(roomCode: string, playerId: string): Promise<LeaveRoomOutput> {
    const left = await deps.joinRoom.leave({ roomCode, playerId });
    cancelGrace(roomCode, playerId);
    await unbindPlayer(roomCode, playerId);
    await announceLeave(roomCode, left);
    return left;
  }

  async function releaseSeatIfAbandoned(roomCode: string, playerId: string): Promise<void> {
    try {
      const sockets = await io.in(roomCode).fetchSockets();
      if (sockets.some((s) => s.data.playerId === playerId)) return; // Player is back.
      await leaveRoom(roomCode, playerId);
    } catch (error) {
      // The player may have left explicitly or the room may already be gone.
      if (!(error instanceof DomainError)) console.error("Error releasing abandoned seat", error);
    }
  }

  /** Joining as someone else or somewhere else first releases the seat bound so far. */
  async function leavePreviousBinding(socket: BattleSocket, roomCode: string, playerId: string): Promise<void> {
    try {
      await leaveRoom(roomCode, playerId);
    } catch (error) {
      // Seat already released or room gone: only this socket's channels are left.
      if (!(error instanceof DomainError)) throw error;
    }
    await unbindSocket(socket);
  }

  io.on("connection", (socket) => {
    // room:join is the only event that binds an identity to the socket: every other
    // event must act as the player (and in the room) recorded here, see requireOwnSeat.
    // Authentication is mocked for now, so the playerId is taken from the payload;
    // once Azure Entra ID is wired it will come from the validated token instead.
    socket.on(ClientEvents.ROOM_JOIN, (payload, ack) =>
      guard(socket, ack, async () => {
        // JoinRoom validates every field (INVALID_PLAYER / ROOM_NOT_FOUND).
        let room = await deps.joinRoom.execute(payload ?? ({} as RoomJoinPayload));
        const playerId = payload.playerId;
        const { roomCode: previousRoom, playerId: previousPlayer } = socket.data;
        // The new seat is taken first, so a failed join leaves the old binding
        // intact; only then is the old seat released, so the socket never keeps a
        // ghost seat nor the old room's events.
        if (
          previousRoom &&
          previousPlayer &&
          (previousRoom.toUpperCase() !== room.code.toUpperCase() || previousPlayer !== playerId)
        ) {
          await leavePreviousBinding(socket, previousRoom, previousPlayer);
          // Same room under a new identity: the departure changed it again.
          if (previousRoom.toUpperCase() === room.code.toUpperCase()) room = await deps.joinRoom.execute(payload);
        }
        cancelGrace(room.code, playerId);
        socket.data.playerId = playerId;
        socket.data.roomCode = room.code;
        await socket.join(room.code);
        await socket.join(playerChannel(playerId));
        publishRoom(room);
        if (room.status === "battling") await resyncWordRound(socket, deps, room.code);
        return toRoomDto(room, new Date());
      }),
    );

    socket.on(ClientEvents.ROLE_SELECT, (payload, ack) =>
      guard(socket, ack, async () => {
        const roomCode = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        const room = await deps.selectRole.execute({ ...payload, roomCode });
        publishRoom(room);
        return toRoomDto(room, new Date());
      }),
    );

    socket.on(ClientEvents.PLAYER_READY, (payload, ack) =>
      guard(socket, ack, async () => {
        const roomCode = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        const room = await deps.setReady.execute({ ...payload, roomCode });
        publishRoom(room);
        return toRoomDto(room, new Date());
      }),
    );

    socket.on(ClientEvents.ROOM_LEAVE, (payload, ack) =>
      guard(socket, ack, async () => {
        const roomCode = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        const left = await leaveRoom(roomCode, payload.playerId);
        return toRoomDtoOrNull(left.room, new Date());
      }),
    );

    socket.on(ClientEvents.PLAYER_KICK, (payload, ack) =>
      guard(socket, ack, async () => {
        const roomCode = requireOwnSeat(socket, payload?.roomCode, payload?.requesterId);
        const room = await deps.kickPlayer.execute({ ...payload, roomCode });
        const kickedId = payload.playerId;
        cancelGrace(room.code, kickedId);
        // Tell every tab of the kicked player, then cut them off the room: they can
        // neither act (requireOwnSeat) nor receive its events any more.
        await unbindPlayer(room.code, kickedId, (kicked) =>
          kicked.emit(ServerEvents.ROOM_KICKED, { roomCode: room.code }),
        );
        publishRoom(room);
        return toRoomDto(room, new Date());
      }),
    );

    socket.on(ClientEvents.BATTLE_START, (payload, ack) =>
      guard(socket, ack, async () => {
        const roomCode = requireOwnSeat(socket, payload?.roomCode, payload?.requesterId);
        const room = await deps.startBattle.execute({ ...payload, roomCode });
        announceBattleStarted(room);
        return toRoomDto(room, new Date());
      }),
    );

    socket.on(ClientEvents.WORD_SUBMIT, (payload, ack) =>
      guard(socket, ack, async () => {
        const roomCode = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        if (!deps.wordRace) throw new DomainError("WORD_RACE_NOT_ACTIVE", "The word race is not enabled");
        const result = await deps.wordRace.submitWord.execute({ ...payload, roomCode });
        // Only the submission whose atomic claim succeeded announces the winner, so
        // the room receives exactly one word:round-ended per round.
        if (result.outcome === "won") {
          const bonus = await awardWordBonus(deps.wordRace, roomCode, payload.playerId);
          io.to(roomCode).emit(
            ServerEvents.WORD_ROUND_ENDED,
            roundEndedPayload(result.race, result.round, bonus ? deps.wordRace.awardWordBonus.points : 0),
          );
          if (bonus) publishRoom(bonus);
        }
        return { outcome: result.outcome, winnerId: result.round.winnerId };
      }),
    );

    socket.on(ClientEvents.SONG_CHALLENGE_START, (payload, ack) =>
      guard(socket, ack, async () => {
        const roomCode = requireOwnSeat(socket, payload?.roomCode, payload?.requesterId);
        const room = await deps.startSongChallenge.execute({ ...payload, roomCode });
        publishRoom(room);
        return toRoomDto(room, new Date());
      }),
    );

    socket.on(ClientEvents.SONG_CHALLENGE_SUBMIT, (payload, ack) =>
      guard(socket, ack, async () => {
        const roomCode = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        const result = await deps.submitSongPhrase.execute({ ...payload, roomCode });
        publishRoom(result.room);
        return { room: toRoomDto(result.room, new Date()), outcome: result.outcome };
      }),
    );

    socket.on(ClientEvents.SONG_CHOOSE, (payload, ack) =>
      guard(socket, ack, async () => {
        const roomCode = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        const { room, battleStarted } = await deps.chooseSong.execute({ ...payload, roomCode });
        if (battleStarted) announceBattleStarted(room);
        else publishRoom(room);
        return toRoomDto(room, new Date());
      }),
    );

    socket.on(ClientEvents.CHAT_MESSAGE, (payload, ack) =>
      guard(socket, ack, async () => {
        const roomCode = requireOwnSeat(socket, payload?.roomCode, payload?.senderId);
        const message = await deps.sendChatMessage.execute({ ...payload, roomCode });
        io.to(message.roomCode).emit(ServerEvents.CHAT_MESSAGE, message);
        return message;
      }),
    );

    socket.on(ClientEvents.RATING_SUBMIT, (payload, ack) =>
      guard(socket, ack, async () => {
        const roomCode = requireOwnSeat(socket, payload?.roomCode, payload?.raterId);
        const { room, finished } = await deps.rateDancer.execute({ ...payload, roomCode });
        if (finished) await announceBattleFinished(room);
        else publishRoom(room);
        return toRoomDto(room, new Date());
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
      scheduleGrace(roomCode, playerId);
    });
  });

  return {
    roomTimers,
    close() {
      for (const timer of graceTimers.values()) clearTimeout(timer);
      graceTimers.clear();
      roomTimers.close();
    },
  };
}

function seatKey(roomCode: string, playerId: string): string {
  return `${roomCode.toUpperCase()}:${playerId}`;
}

/** Drops the socket's binding and its room and player channels. */
async function unbindSocket(socket: BattleSocket): Promise<void> {
  const { roomCode, playerId } = socket.data;
  socket.data.roomCode = undefined;
  socket.data.playerId = undefined;
  if (roomCode) await socket.leave(roomCode);
  if (playerId) await socket.leave(playerChannel(playerId));
}

/**
 * Pays the word round bonus to the winner. Returns the updated room, or null when
 * the battle is already over or the winner left: the round still ends, without a bonus.
 */
async function awardWordBonus(
  wordRace: WordRaceSocketDependencies,
  roomCode: string,
  playerId: string,
): Promise<Room | null> {
  try {
    return await wordRace.awardWordBonus.execute({ roomCode, playerId });
  } catch (error) {
    // Expected when the battle finished or the winner left meanwhile; still logged,
    // so a bonus that was not paid can always be traced.
    if (error instanceof DomainError) {
      console.warn(`Word bonus not awarded in room ${roomCode} to ${playerId}: ${error.code} ${error.message}`);
    } else {
      console.error("Error awarding the word bonus", error);
    }
    return null;
  }
}

/** A client that (re)joins mid-round gets the word on screen with the time actually left. */
async function resyncWordRound(socket: BattleSocket, deps: SocketDependencies, roomCode: string): Promise<void> {
  if (!deps.wordRace) return;
  const active = await deps.wordRace.getActiveWordRound.execute({ roomCode });
  if (active) socket.emit(ServerEvents.WORD_ROUND_STARTED, roundStartedPayload(active.race, active.round, new Date()));
}

function playerChannel(playerId: string): string {
  return `player:${playerId}`;
}

/**
 * Ensures the socket joined `roomCode` as `playerId` (the identity bound by
 * room:join), so a client can neither act in a room it is not in nor
 * impersonate another player: kick them, start as the host, chat or rate as
 * them. Room codes are case-insensitive, like the repository lookup. Returns
 * the canonical code of the joined room.
 */
function requireOwnSeat(socket: BattleSocket, roomCode: unknown, playerId: unknown): string {
  const { roomCode: joinedRoom, playerId: joinedPlayer } = socket.data;
  if (
    !joinedRoom ||
    !joinedPlayer ||
    typeof roomCode !== "string" ||
    roomCode.toUpperCase() !== joinedRoom.toUpperCase() ||
    playerId !== joinedPlayer
  ) {
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
 *
 * The ack argument comes straight from the client: Socket.IO hands over whatever
 * trailing argument was sent, so it is only called when it really is a function.
 * The returned promise never rejects, because an unhandled rejection would stop
 * the process and drop every room held in memory.
 */
async function guard<T>(socket: BattleSocket, ack: Ack<T> | undefined, handler: () => Promise<T>): Promise<void> {
  const reply: Ack<T> | undefined = typeof ack === "function" ? ack : undefined;
  try {
    const data = await handler();
    reply?.({ ok: true, data });
  } catch (error) {
    try {
      const payload =
        error instanceof DomainError
          ? { code: error.code, message: error.message }
          : { code: "INTERNAL_ERROR", message: "Unexpected server error" };
      if (!(error instanceof DomainError)) console.error("Unhandled socket error", error);
      if (reply) reply({ ok: false, error: payload });
      else socket.emit(ServerEvents.ERROR, payload);
    } catch (replyError) {
      console.error("Error reporting a socket error", replyError);
    }
  }
}
