import type { RemoteSocket, Server, Socket } from "socket.io";
import type { JoinRoom, JoinRoomInput, LeaveRoomOutput } from "../../application/usecases/JoinRoom.js";
import type { KickPlayer } from "../../application/usecases/KickPlayer.js";
import type { ReapRooms } from "../../application/usecases/ReapRooms.js";
import type { CastVote } from "../../application/usecases/CastVote.js";
import type { RecordMatchResult } from "../../application/usecases/RecordMatchResult.js";
import type { StartRematch } from "../../application/usecases/StartRematch.js";
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
import { AuthError, mayActInRoom, type AuthIdentity } from "../../application/auth/AuthIdentity.js";
import type { LogFields, Logger } from "../../application/ports/Logger.js";
import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import { RoomService } from "../../domain/services/RoomService.js";
import { consoleAuthAudit, correlationIdFrom, type AuthAuditLog } from "../auth/authAudit.js";
import { rootLogger } from "../logging/logger.js";
import { RoomTimers } from "../scheduling/RoomTimers.js";
import type { WordRaceScheduler } from "../scheduling/WordRaceScheduler.js";
import { toRoomDto, toRoomDtoOrNull } from "../serialization/roomDto.js";
import type { HandshakeAuthenticator } from "./handshakeAuth.js";
import { roundEndedPayload, roundStartedPayload } from "./wordRaceMessages.js";
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
/** A socket of this replica or of another one (through the adapter). */
type AnySocket = RemoteSocket<ServerToClientEvents, SocketData>;

export interface SocketDependencies {
  /**
   * Authenticates every handshake before the connection is accepted (SEG-1);
   * see createHandshakeAuth. It must set socket.data.auth or refuse the socket.
   */
  authenticateHandshake: HandshakeAuthenticator;
  /** Where refused attempts are recorded. Default: one JSON line per rejection on stderr. */
  authAudit?: AuthAuditLog;
  joinRoom: JoinRoom;
  startBattle: StartBattle;
  sendChatMessage: SendChatMessage;
  /** Spectators' votes (HU 20). */
  castVote: CastVote;
  /** The host's rematch of a finished room (HU 18). */
  startRematch: StartRematch;
  selectRole: SelectRole;
  setReady: SetReady;
  startSongChallenge: StartSongChallenge;
  submitSongPhrase: SubmitSongPhrase;
  chooseSong: ChooseSong;
  kickPlayer: KickPlayer;
  /** Ends a battle still running at battle.endsAt (the end of the song clip). */
  finishBattleAtDeadline: FinishBattleAtDeadline;
  /**
   * Stores every finished battle in the match history (HU 21), in the
   * background, through a durable outbox the sweep drains (DIS-1). Optional so
   * harnesses that do not exercise it can omit it.
   */
  recordMatchResult?: RecordMatchResult;
  /** Lists rooms and deletes empty ones for the abandoned-room sweep. */
  reapRooms: ReapRooms;
  /** Seat retention after a disconnect, see env.disconnectGraceMs. */
  disconnectGraceMs: number;
  /**
   * Seat retention after a "pagehide" leave beacon (see env.pagehideGraceMs):
   * long enough for a reloading page to rejoin, short enough that a closed tab
   * frees its seat quickly. Default 3 s.
   */
  pagehideGraceMs?: number;
  /** Abandoned-room housekeeping timings; defaults suit production. */
  reaping?: ReapingOptions;
  /** Mid-battle word race. Optional so harnesses that do not exercise it can omit it. */
  wordRace?: WordRaceSocketDependencies;
  /** Structured logs (OBS-1). Default: the process logger. */
  logger?: Logger;
}

export interface WordRaceSocketDependencies {
  scheduler: WordRaceScheduler;
  submitWord: SubmitWord;
  awardWordBonus: AwardWordBonus;
  getActiveWordRound: GetActiveWordRound;
}

export interface ReapingOptions {
  /**
   * How long a room created over HTTP waits for its host's socket before the
   * host's seat is released (and the then empty room deleted).
   * Default: disconnectGraceMs + 5 s.
   */
  createdRoomGraceMs?: number;
  /** Interval of the sweep releasing seats without a socket. Default: 60 s. */
  sweepIntervalMs?: number;
}

const CREATED_ROOM_MARGIN_MS = 5_000;
const DEFAULT_PAGEHIDE_GRACE_MS = 3_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Lets the owner stop every timer the handlers own (tests, graceful shutdown). */
export interface SocketHandlersHandle {
  /** Stops every timer (grace, deadlines, reaping); call on shutdown. */
  close(): void;
  /**
   * A room was just created over HTTP: if its host never binds a socket to it
   * within createdRoomGraceMs, the seat is released and the empty room deleted.
   */
  watchNewRoom(roomCode: string, hostId: string): void;
  /** One pass of the periodic sweep (also run every sweepIntervalMs). */
  sweep(): Promise<void>;
  /**
   * The player leaves the room through the same path as room:leave (seat
   * released, host handed over, battle settled, every socket of the player
   * unbound, broadcasts). Used by POST /api/rooms/:code/leave.
   */
  leave(roomCode: string, playerId: string): Promise<LeaveRoomOutput>;
  /**
   * The player's page sent a leave beacon on `pagehide`, which browsers fire on
   * a reload as well as on a tab close. The seat is released after
   * pagehideGraceMs unless a socket of the player is bound to the room by then
   * (a reload rejoins), exactly like the disconnect grace but shorter.
   */
  leaveAfterPagehide(roomCode: string, playerId: string): void;
  /** Deadline timers per room (song challenge, ...), exposed so tests can prove nothing leaks. */
  readonly roomTimers: RoomTimers;
}

export function registerSocketHandlers(io: BattleServer, deps: SocketDependencies): SocketHandlersHandle {
  /**
   * Pending seat releases after a disconnect, one per (room, player). A newer
   * disconnect replaces the timer and a rejoin cancels it, so an old timer can
   * never release a seat that a later reconnect renewed.
   */
  const audit = deps.authAudit ?? consoleAuthAudit;
  const logger = deps.logger ?? rootLogger;
  // No connection is accepted without a valid token: this runs before "connection".
  io.use(deps.authenticateHandshake);
  const graceTimers = new Map<string, NodeJS.Timeout>();
  /** When each pending grace timer fires (epoch ms), so a later, longer grace never postpones it. */
  const graceDeadlines = new Map<string, number>();
  const roomTimers = new RoomTimers();
  /**
   * Version of the room state the timers were last armed from. Two handlers can
   * publish out of order (version N after N+1); an older state must not clear or
   * replace the deadlines derived from a newer one.
   */
  const armedVersions = new Map<string, number>();
  /** Rooms created over HTTP waiting for their host's first socket. */
  const newRoomTimers = new Map<string, NodeJS.Timeout>();
  /** When each seat was last seen without any bound socket (seatKey -> epoch ms). */
  const unboundSince = new Map<string, number>();
  const createdRoomGraceMs = deps.reaping?.createdRoomGraceMs ?? deps.disconnectGraceMs + CREATED_ROOM_MARGIN_MS;
  const sweepTimer = setInterval(() => {
    sweep().catch((error: unknown) => logger.error({ err: error }, "Error sweeping abandoned rooms"));
  }, deps.reaping?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

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
    const key = room.code.toUpperCase();
    if (room.version < (armedVersions.get(key) ?? -1)) return;
    armedVersions.set(key, room.version);
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
    // The automatic end of the battle: the end of the song clip.
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
      // Timer-driven: no request carries a correlation id, so the battle it may start gets a new one.
      result = await deps.chooseSong.autoPick({ roomCode, challengeId, correlationId: correlationIdFrom(undefined) });
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
    const log = logger.child(battleFields(room));
    log.info({ dancers: room.battle?.dancerIds.length, spectators: room.battle?.audience.length }, "Battle started");
    io.to(room.code).emit(ServerEvents.BATTLE_STARTED, toRoomDto(room, new Date()));
    publishRoom(room);
    // The battle already started; a failure planning the word race must not undo it.
    deps.wordRace?.scheduler
      .start(room.code)
      .catch((error: unknown) => log.error({ err: error }, "Error starting the word race"));
  }

  /**
   * Single exit for every path that finishes a battle (song end, leave,
   * released seat): room:updated, then battle:finished, then every battle timer
   * stops (publishRoom clears the battle-end deadline). Only the atomic update
   * that finished the battle reports it, so this runs once per battle, and so
   * does the match history record, sent in the background: a slow or
   * unavailable users-service never delays the room.
   */
  async function announceBattleFinished(room: Room): Promise<void> {
    const log = logger.child(battleFields(room));
    log.info(
      { endReason: room.battle?.endReason, durationSeconds: battleDurationSeconds(room), winnerId: room.battle?.result?.winnerId },
      "Battle finished",
    );
    publishRoom(room);
    io.to(room.code).emit(ServerEvents.BATTLE_FINISHED, toRoomDto(room, new Date()));
    deps.recordMatchResult
      ?.execute(room)
      .catch((error: unknown) => log.error({ err: error }, "Error recording the match result"));
    await deps.wordRace?.scheduler.stop(room.code);
  }

  /**
   * DIS-1: arms on this replica the timers of the room's pending word rounds
   * (from their absolute times in the store) and pays any bonus of a won round
   * that the claiming replica could not pay before dying. Safe to run on every
   * replica and as often as wanted: timers are armed once per replica, round
   * transitions are atomic and only the replica whose transition applied
   * broadcasts it, and bonuses are paid once per round. Never throws: the word
   * race must not break a join or the sweep.
   */
  async function resumeWordRace(roomCode: string): Promise<void> {
    const wordRace = deps.wordRace;
    if (!wordRace) return;
    try {
      const race = await wordRace.scheduler.resume(roomCode);
      if (!race) return;
      const { room, paidRoundIds } = await wordRace.awardWordBonus.reconcile(race);
      if (room && paidRoundIds.length > 0) {
        logger.warn({ ...battleFields(room), roundIds: paidRoundIds }, "Word bonus paid on resume");
        publishRoom(room);
      }
    } catch (error) {
      if (!(error instanceof DomainError)) logger.error({ roomId: roomCode, err: error }, "Error resuming the word race");
    }
  }

  /** Tells a spectator (every tab, through their player channel) what their current vote is. */
  function emitVoteMine(roomCode: string, voterId: string, dancerId: string | null): void {
    io.to(playerChannel(voterId)).emit(ServerEvents.VOTE_MINE, { roomCode, dancerId });
  }

  /**
   * Broadcasts the outcome of a departure (room:leave, the HTTP leave endpoint or
   * a seat released after the disconnect grace period). The departure may have
   * finished the battle, which is announced like any other finish.
   */
  async function announceLeave(roomCode: string, { room, battleFinished, discardedVoterIds }: LeaveRoomOutput): Promise<void> {
    // Their dancer left: those spectators lost their vote and may vote again.
    if (room) for (const voterId of discardedVoterIds) emitVoteMine(room.code, voterId, null);
    if (!room) {
      // The last player left: the room is gone, and so is every timer it had.
      forgetRoomTimers(roomCode);
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

  function forgetRoomTimers(roomCode: string): void {
    roomTimers.clearRoom(roomCode);
    armedVersions.delete(roomCode.toUpperCase());
  }

  function cancelGrace(roomCode: string, playerId: string): void {
    const key = seatKey(roomCode, playerId);
    clearTimeout(graceTimers.get(key));
    graceTimers.delete(key);
    graceDeadlines.delete(key);
  }

  /**
   * Releases the seat after `delayMs` unless the player is bound to the room
   * again by then (a rejoin cancels the timer). One timer per seat: a new grace
   * replaces the pending one, except that it never postpones it. A tab close
   * sends the pagehide beacon (3 s) and then drops its socket (15 s); the seat
   * must still be released after 3 s.
   */
  function scheduleGrace(roomCode: string, playerId: string, delayMs: number = deps.disconnectGraceMs): void {
    const key = seatKey(roomCode, playerId);
    const deadline = Date.now() + delayMs;
    const pending = graceDeadlines.get(key);
    if (graceTimers.has(key) && pending !== undefined && pending <= deadline) return;
    cancelGrace(roomCode, playerId);
    if (!unboundSince.has(key)) unboundSince.set(key, Date.now());
    const timer = setTimeout(() => {
      graceTimers.delete(key);
      graceDeadlines.delete(key);
      void releaseSeatIfAbandoned(roomCode, playerId, `no socket ${delayMs} ms after a disconnect`);
    }, delayMs);
    timer.unref();
    graceTimers.set(key, timer);
    graceDeadlines.set(key, deadline);
  }

  /**
   * Detaches every socket bound to (roomCode, playerId), on every replica
   * (DIS-1: with several replicas a player's tabs may sit on another one): it
   * leaves the room and player channels, so a second tab of a player who left
   * can neither receive the room's events nor act (requireOwnSeat checks the
   * room channel, and clears the stale binding of a socket of another replica).
   */
  async function unbindPlayer(
    roomCode: string,
    playerId: string,
    beforeUnbind?: (socket: AnySocket) => void,
  ): Promise<void> {
    for (const socket of await io.in(playerChannel(playerId)).fetchSockets()) {
      const { roomCode: bound, playerId: boundPlayer } = socket.data;
      if (!bound || boundPlayer !== playerId || bound.toUpperCase() !== roomCode.toUpperCase()) continue;
      beforeUnbind?.(socket);
      socket.leave(bound);
      socket.leave(playerChannel(playerId));
      // A socket of this replica also loses its binding right away.
      const local = io.of("/").sockets.get(socket.id);
      if (local) await unbindSocket(local);
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

  async function releaseSeatIfAbandoned(roomCode: string, playerId: string, why: string): Promise<void> {
    try {
      if (await isBound(roomCode, playerId)) return; // Player is back.
      // Traceable (DIS-1): a seat released during a failover means a client did not get back in time.
      logger.info({ roomId: roomCode, playerId, why }, "Seat released");
      await leaveRoom(roomCode, playerId);
    } catch (error) {
      // The player may have left explicitly or the room may already be gone.
      if (!(error instanceof DomainError)) logger.error({ roomId: roomCode, playerId, err: error }, "Error releasing abandoned seat");
    }
  }

  async function isBound(roomCode: string, playerId: string): Promise<boolean> {
    const sockets = await io.in(roomCode).fetchSockets();
    return sockets.some((s) => s.data.playerId === playerId);
  }

  function watchNewRoom(roomCode: string, hostId: string): void {
    const key = seatKey(roomCode, hostId);
    clearTimeout(newRoomTimers.get(key));
    const timer = setTimeout(() => {
      newRoomTimers.delete(key);
      // A pending disconnect grace means the host did connect: that timer decides.
      if (graceTimers.has(key)) return;
      void releaseHostOfUnusedRoom(roomCode, hostId);
    }, createdRoomGraceMs);
    timer.unref();
    newRoomTimers.set(key, timer);
  }

  /**
   * The new-room deadline only reaps a room nobody used: the host still alone
   * in the lobby. A room that others joined (or a battle) proves the host did
   * connect; from then on the seat follows the grace period and the sweep,
   * which need it unbound for disconnectGraceMs. DIS-1: this timer lives on the
   * replica that served POST /api/rooms, so it may fire while the host is
   * reconnecting after a failover, and a single "not bound right now" must not
   * release a seat in a running battle.
   */
  async function releaseHostOfUnusedRoom(roomCode: string, hostId: string): Promise<void> {
    try {
      const room = await deps.reapRooms.find(roomCode);
      if (!room || room.status !== "waiting" || room.players.some((p) => p.id !== hostId)) return;
    } catch (error) {
      logger.error({ roomId: roomCode, err: error }, "Error reading a new room before reaping it");
      return;
    }
    await releaseSeatIfAbandoned(roomCode, hostId, "the host never connected after creating the room");
  }

  /**
   * Safety net behind the grace timers: releases every seat that has had no
   * bound socket for longer than the disconnect grace period (through the
   * normal leave path, which also finishes a battle the departure ends),
   * deletes rooms left empty, and re-arms each room's deadlines, which settles
   * any deadline whose timer did not run.
   *
   * DIS-1: every replica runs it, so it also takes over what a dead replica
   * left behind (word races, undelivered match results), and one room that
   * fails (e.g. an adapter request timing out) never stops the others.
   */
  async function sweep(): Promise<void> {
    const now = Date.now();
    const seen = new Set<string>();
    // Rooms whose timers this replica armed before listing: those missing from
    // the list were deleted elsewhere, and their timers can go.
    const armedBefore = [...armedVersions.keys()];
    const listed = new Set<string>();
    for (const room of await deps.reapRooms.list()) {
      listed.add(room.code.toUpperCase());
      for (const player of room.players) seen.add(seatKey(room.code, player.id));
      try {
        await sweepRoom(room, now);
      } catch (error) {
        logger.error({ roomId: room.code, err: error }, "Error sweeping room");
        // Its seats could not be observed: a gap in the observations must never
        // count as time without a socket (DIS-1, e.g. during a failover).
        for (const player of room.players) unboundSince.delete(seatKey(room.code, player.id));
      }
    }
    for (const key of armedBefore) if (!listed.has(key)) forgetRoomTimers(key);
    // Forget seats that no longer exist.
    for (const key of unboundSince.keys()) if (!seen.has(key)) unboundSince.delete(key);
    // DIS-1: every replica delivers the results still pending, whoever finished the battle.
    await deps.recordMatchResult?.drain();
  }

  async function sweepRoom(room: Room, now: number): Promise<void> {
    // DIS-1: a finisher that died before enqueuing its result leaves it to this sweep.
    if (room.status === "finished") await deps.recordMatchResult?.enqueueFinished(room);
    if (room.players.length === 0) {
      if (await deps.reapRooms.deleteIfEmpty(room.code)) {
        await announceLeave(room.code, { room: null, battleFinished: false, discardedVoterIds: [] });
      }
      return;
    }
    armRoomTimers(room);
    if (room.status === "battling") await resumeWordRace(room.code);
    const bound = new Set((await io.in(room.code).fetchSockets()).map((s) => s.data.playerId));
    for (const player of room.players) {
      const key = seatKey(room.code, player.id);
      if (bound.has(player.id)) {
        unboundSince.delete(key);
        continue;
      }
      // A pending grace or new-room timer will decide this seat on its own.
      if (graceTimers.has(key) || newRoomTimers.has(key)) continue;
      const since = unboundSince.get(key);
      if (since === undefined) {
        unboundSince.set(key, now);
      } else if (now - since >= deps.disconnectGraceMs) {
        unboundSince.delete(key);
        await releaseSeatIfAbandoned(room.code, player.id, `unbound for ${now - since} ms (sweep)`);
      }
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
    const log = logger.child({
      correlationId: socket.data.correlationId,
      socketId: socket.id,
      userKind: socket.data.auth?.kind,
    });
    log.info({ playerId: socket.data.auth?.playerId }, "Socket connected");
    /** Runs a client event through guard, logging it with this connection's correlation id. */
    const handle = <T>(event: string, ack: Ack<T> | undefined, handler: () => Promise<T>): Promise<void> =>
      guard(socket, ack, handler, { event, log });

    // room:join binds the socket to a seat: every other event must act in the room
    // recorded here, see requireOwnSeat. The player is the one identified by the
    // token validated in the handshake, never an id sent by the client.
    socket.on(ClientEvents.ROOM_JOIN, (payload, ack) =>
      handle(ClientEvents.ROOM_JOIN, ack, async () => {
        const identity = requireIdentity(socket);
        const playerId = identity.playerId;
        requireRoomScope(socket, identity, payload?.roomCode, ClientEvents.ROOM_JOIN, audit);
        // JoinRoom validates every field (INVALID_PLAYER / ROOM_NOT_FOUND).
        const join = {
          roomCode: payload?.roomCode,
          playerId,
          displayName: payload?.displayName ?? identity.displayName,
        } as JoinRoomInput;
        let room = await deps.joinRoom.execute(join);
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
          if (previousRoom.toUpperCase() === room.code.toUpperCase()) room = await deps.joinRoom.execute(join);
        }
        cancelGrace(room.code, playerId);
        unboundSince.delete(seatKey(room.code, playerId));
        socket.data.playerId = playerId;
        socket.data.roomCode = room.code;
        await socket.join(room.code);
        await socket.join(playerChannel(playerId));
        publishRoom(room);
        if (room.status === "battling") {
          // DIS-1: this replica takes the word race over if the one running its
          // timers died (the player may be rejoining precisely because of that).
          await resumeWordRace(room.code);
          await resyncWordRound(socket, deps, room.code);
        }
        // A spectator back after a refresh gets their vote again (privately).
        if (room.battle && room.spectators.some((s) => s.id === playerId)) {
          socket.emit(ServerEvents.VOTE_MINE, { roomCode: room.code, dancerId: RoomService.voteOf(room, playerId) });
        }
        return toRoomDto(room, new Date());
      }),
    );

    socket.on(ClientEvents.ROLE_SELECT, (payload, ack) =>
      handle(ClientEvents.ROLE_SELECT, ack, async () => {
        const { roomCode, playerId } = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        const room = await deps.selectRole.execute({ ...payload, roomCode, playerId });
        publishRoom(room);
        return toRoomDto(room, new Date());
      }),
    );

    socket.on(ClientEvents.PLAYER_READY, (payload, ack) =>
      handle(ClientEvents.PLAYER_READY, ack, async () => {
        const { roomCode, playerId } = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        const room = await deps.setReady.execute({ ...payload, roomCode, playerId });
        publishRoom(room);
        return toRoomDto(room, new Date());
      }),
    );

    socket.on(ClientEvents.ROOM_LEAVE, (payload, ack) =>
      handle(ClientEvents.ROOM_LEAVE, ack, async () => {
        const { roomCode, playerId } = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        const left = await leaveRoom(roomCode, playerId);
        return toRoomDtoOrNull(left.room, new Date());
      }),
    );

    socket.on(ClientEvents.PLAYER_KICK, (payload, ack) =>
      handle(ClientEvents.PLAYER_KICK, ack, async () => {
        const { roomCode, playerId: requesterId } = requireOwnSeat(socket, payload?.roomCode, payload?.requesterId);
        const room = await deps.kickPlayer.execute({ ...payload, roomCode, requesterId });
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
      handle(ClientEvents.BATTLE_START, ack, async () => {
        const { roomCode, playerId: requesterId } = requireOwnSeat(socket, payload?.roomCode, payload?.requesterId);
        const room = await deps.startBattle.execute({
          ...payload,
          roomCode,
          requesterId,
          correlationId: socket.data.correlationId,
        });
        announceBattleStarted(room);
        return toRoomDto(room, new Date());
      }),
    );

    socket.on(ClientEvents.WORD_SUBMIT, (payload, ack) =>
      handle(ClientEvents.WORD_SUBMIT, ack, async () => {
        const { roomCode, playerId } = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        if (!deps.wordRace) throw new DomainError("WORD_RACE_NOT_ACTIVE", "The word race is not enabled");
        const result = await deps.wordRace.submitWord.execute({ ...payload, roomCode, playerId });
        // Only the submission whose atomic claim succeeded announces the winner, so
        // the room receives exactly one word:round-ended per round.
        if (result.outcome === "won") {
          logger.info(
            { ...raceFields(result.race), roundId: result.round.id, outcome: "won", winnerId: playerId },
            "Word round ended",
          );
          const bonus = await awardWordBonus(deps.wordRace, roomCode, playerId, result.round.id, logger);
          io.to(roomCode).emit(
            ServerEvents.WORD_ROUND_ENDED,
            roundEndedPayload(result.race, result.round, bonus?.battle?.scoring.wordBonusPoints ?? 0),
          );
          if (bonus) publishRoom(bonus);
        }
        return { outcome: result.outcome, winnerId: result.round.winnerId };
      }),
    );

    socket.on(ClientEvents.SONG_CHALLENGE_START, (payload, ack) =>
      handle(ClientEvents.SONG_CHALLENGE_START, ack, async () => {
        const { roomCode, playerId: requesterId } = requireOwnSeat(socket, payload?.roomCode, payload?.requesterId);
        const room = await deps.startSongChallenge.execute({ ...payload, roomCode, requesterId });
        publishRoom(room);
        return toRoomDto(room, new Date());
      }),
    );

    socket.on(ClientEvents.SONG_CHALLENGE_SUBMIT, (payload, ack) =>
      handle(ClientEvents.SONG_CHALLENGE_SUBMIT, ack, async () => {
        const { roomCode, playerId } = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        const result = await deps.submitSongPhrase.execute({ ...payload, roomCode, playerId });
        publishRoom(result.room);
        return { room: toRoomDto(result.room, new Date()), outcome: result.outcome };
      }),
    );

    socket.on(ClientEvents.SONG_CHOOSE, (payload, ack) =>
      handle(ClientEvents.SONG_CHOOSE, ack, async () => {
        const { roomCode, playerId } = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        const { room, battleStarted } = await deps.chooseSong.execute({
          ...payload,
          roomCode,
          playerId,
          correlationId: socket.data.correlationId,
        });
        if (battleStarted) announceBattleStarted(room);
        else publishRoom(room);
        return toRoomDto(room, new Date());
      }),
    );

    socket.on(ClientEvents.CHAT_MESSAGE, (payload, ack) =>
      handle(ClientEvents.CHAT_MESSAGE, ack, async () => {
        const { roomCode, playerId: senderId } = requireOwnSeat(socket, payload?.roomCode, payload?.senderId);
        const message = await deps.sendChatMessage.execute({ ...payload, roomCode, senderId });
        io.to(message.roomCode).emit(ServerEvents.CHAT_MESSAGE, message);
        return message;
      }),
    );

    socket.on(ClientEvents.VOTE_CAST, (payload, ack) =>
      handle(ClientEvents.VOTE_CAST, ack, async () => {
        const { roomCode, playerId: voterId } = requireOwnSeat(socket, payload?.roomCode, payload?.voterId);
        const { room, dancerId, changed } = await deps.castVote.execute({
          roomCode,
          voterId,
          dancerId: payload.dancerId,
        });
        // Everyone gets the new totals; only the voter's own tabs learn the choice.
        if (changed) publishRoom(room);
        emitVoteMine(room.code, voterId, dancerId);
        return { dancerId };
      }),
    );

    socket.on(ClientEvents.ROOM_REMATCH, (payload, ack) =>
      handle(ClientEvents.ROOM_REMATCH, ack, async () => {
        const { roomCode, playerId: requesterId } = requireOwnSeat(socket, payload?.roomCode, payload?.requesterId);
        const { room, clearedVoterIds } = await deps.startRematch.execute({ roomCode, requesterId });
        // Back in the lobby: no word race, and publishRoom clears every battle deadline.
        await deps.wordRace?.scheduler.stop(room.code);
        publishRoom(room);
        for (const voterId of clearedVoterIds) emitVoteMine(room.code, voterId, null);
        return toRoomDto(room, new Date());
      }),
    );

    // WebRTC signaling is a thin relay: it checks room membership and forwards
    // opaque payloads. Media flows peer to peer and never reaches the server.
    socket.on(ClientEvents.WEBRTC_READY, (payload, ack) =>
      handle(ClientEvents.WEBRTC_READY, ack, async () => {
        const { roomCode, playerId } = requireOwnSeat(socket, payload?.roomCode, payload?.playerId);
        socket.to(roomCode).emit(ServerEvents.WEBRTC_PEER_READY, { playerId });
        return null;
      }),
    );

    socket.on(ClientEvents.WEBRTC_SIGNAL, (payload, ack) =>
      handle(ClientEvents.WEBRTC_SIGNAL, ack, async () => {
        const { roomCode, playerId: from } = requireOwnSeat(socket, payload?.roomCode, payload?.from);
        const signal = requireValidSignal({ ...payload, from });
        const roomSockets = await io.in(roomCode).fetchSockets();
        if (!roomSockets.some((s) => s.data.playerId === signal.to)) {
          throw new DomainError("PLAYER_NOT_IN_ROOM", `Player ${signal.to} is not connected to room ${roomCode}`);
        }
        io.to(playerChannel(signal.to)).emit(ServerEvents.WEBRTC_SIGNAL, signal);
        return null;
      }),
    );

    // A socket unbound from another replica (kick, leave) still carries its old
    // binding here; its seat is no longer its own, so no grace period applies.
    socket.on("disconnecting", () => {
      const { roomCode } = socket.data;
      if (roomCode && !socket.rooms.has(roomCode)) clearBinding(socket);
    });

    socket.on("disconnect", (reason) => {
      const { playerId, roomCode } = socket.data;
      log.info({ roomId: roomCode, reason }, "Socket disconnected");
      if (!playerId || !roomCode) return;
      // A refresh or a transient network drop disconnects the socket too. Removing the
      // player immediately would delete a room whose only player is reloading the page,
      // so the seat is kept for a grace period and released only if nobody rejoined.
      scheduleGrace(roomCode, playerId);
    });
  });

  return {
    roomTimers,
    watchNewRoom,
    sweep,
    leave: leaveRoom,
    leaveAfterPagehide(roomCode, playerId) {
      scheduleGrace(roomCode, playerId, deps.pagehideGraceMs ?? DEFAULT_PAGEHIDE_GRACE_MS);
    },
    close() {
      for (const timer of graceTimers.values()) clearTimeout(timer);
      graceTimers.clear();
      graceDeadlines.clear();
      for (const timer of newRoomTimers.values()) clearTimeout(timer);
      newRoomTimers.clear();
      clearInterval(sweepTimer);
      roomTimers.close();
      armedVersions.clear();
    },
  };
}

function seatKey(roomCode: string, playerId: string): string {
  return `${roomCode.toUpperCase()}:${playerId}`;
}

/** Drops the socket's binding and its room and player channels. */
async function unbindSocket(socket: BattleSocket): Promise<void> {
  const { roomCode, playerId } = socket.data;
  clearBinding(socket);
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
  roundId: string,
  logger: Logger,
): Promise<Room | null> {
  try {
    return await wordRace.awardWordBonus.execute({ roomCode, playerId, roundId });
  } catch (error) {
    // Expected when the battle finished or the winner left meanwhile; still logged,
    // so a bonus that was not paid can always be traced.
    if (error instanceof DomainError) {
      logger.warn({ roomId: roomCode, playerId, roundId, code: error.code, reason: error.message }, "Word bonus not awarded");
    } else {
      logger.error({ roomId: roomCode, playerId, roundId, err: error }, "Error awarding the word bonus");
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

function clearBinding(socket: BattleSocket): void {
  socket.data.roomCode = undefined;
  socket.data.playerId = undefined;
}

function playerChannel(playerId: string): string {
  return `player:${playerId}`;
}

/** The identity proven by the handshake token. The handshake middleware guarantees it exists. */
function requireIdentity(socket: BattleSocket): AuthIdentity {
  const identity = socket.data.auth;
  if (!identity) throw new AuthError("UNAUTHORIZED", "missing_token");
  return identity;
}

/**
 * A guest token is valid for one room only: joining any other room with it is
 * refused with FORBIDDEN and recorded, and the socket stays unbound.
 */
function requireRoomScope(
  socket: BattleSocket,
  identity: AuthIdentity,
  roomCode: unknown,
  event: string,
  audit: AuthAuditLog,
): void {
  // A code that is not a string is refused by JoinRoom (ROOM_NOT_FOUND) right after.
  if (typeof roomCode !== "string" || mayActInRoom(identity, roomCode)) return;
  const failure = new AuthError("FORBIDDEN", "guest_out_of_scope", "A guest token is only valid for its own room");
  audit.rejected({
    channel: "socket.io",
    code: failure.code,
    reason: failure.reason,
    correlationId: socket.data.correlationId ?? correlationIdFrom(undefined),
    socketEvent: event,
  });
  throw failure;
}

/**
 * Ensures the socket joined `roomCode` and returns the canonical code of that
 * room with the acting player, who is always the one bound by room:join from
 * the handshake token. A client can therefore neither act in a room it is not
 * in nor impersonate another player (kick them, start as the host, chat or
 * vote as them): an id it sends is only cross-checked, and naming someone else
 * is refused. Room codes are case-insensitive, like the repository lookup.
 *
 * The socket must still be in the room channel: another replica may have
 * unbound it (kick, leave from another tab) and could only take it out of the
 * channel, not clear its binding here (DIS-1). Such a stale binding is cleared.
 */
function requireOwnSeat(
  socket: BattleSocket,
  roomCode: unknown,
  claimedPlayerId: unknown,
): { roomCode: string; playerId: string } {
  const { roomCode: joinedRoom, playerId: joinedPlayer } = socket.data;
  if (
    !joinedRoom ||
    !joinedPlayer ||
    typeof roomCode !== "string" ||
    roomCode.toUpperCase() !== joinedRoom.toUpperCase() ||
    (claimedPlayerId !== undefined && claimedPlayerId !== joinedPlayer)
  ) {
    throw new DomainError("PLAYER_NOT_IN_ROOM", "The socket has not joined this room as this player");
  }
  if (!socket.rooms.has(joinedRoom)) {
    clearBinding(socket);
    throw new DomainError("PLAYER_NOT_IN_ROOM", "The socket was removed from this room");
  }
  return { roomCode: joinedRoom, playerId: joinedPlayer };
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

/** What guard needs to observe an event (OBS-1). */
interface GuardContext {
  /** The client event being handled; a bounded set of names. */
  event: string;
  /** The connection's logger (correlationId, socketId, userKind). */
  log: Logger;
}

/** Events too chatty for the info level: WebRTC signaling relays every ICE candidate. */
const DEBUG_EVENTS = new Set<string>([ClientEvents.WEBRTC_SIGNAL, ClientEvents.WEBRTC_READY]);

/**
 * Runs a handler, replying through the ack callback when provided and emitting a
 * domain error event to the calling socket otherwise.
 *
 * The ack argument comes straight from the client: Socket.IO hands over whatever
 * trailing argument was sent, so it is only called when it really is a function.
 * The returned promise never rejects, because an unhandled rejection would stop
 * the process and drop every room held in memory.
 *
 * OBS-1: every handled event is logged once, with the connection's correlation
 * id, the event name, the room and how long it took (receive to reply). The
 * payload is never logged.
 */
async function guard<T>(
  socket: BattleSocket,
  ack: Ack<T> | undefined,
  handler: () => Promise<T>,
  { event, log }: GuardContext,
): Promise<void> {
  const reply: Ack<T> | undefined = typeof ack === "function" ? ack : undefined;
  const startedAt = performance.now();
  const roomBefore = socket.data.roomCode;
  const done = (fields: LogFields): void => {
    const line = {
      event,
      roomId: socket.data.roomCode ?? roomBefore,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      ...fields,
    };
    if (DEBUG_EVENTS.has(event) && fields.ok) log.debug(line, "Socket event handled");
    else log.info(line, "Socket event handled");
  };
  try {
    const data = await handler();
    reply?.({ ok: true, data });
    done({ ok: true });
  } catch (error) {
    try {
      const expected = error instanceof DomainError || error instanceof AuthError;
      const payload = expected
        ? { code: error.code, message: error.message }
        : { code: "INTERNAL_ERROR", message: "Unexpected server error" };
      if (!expected) log.error({ event, roomId: socket.data.roomCode ?? roomBefore, err: error }, "Unhandled socket error");
      if (reply) reply({ ok: false, error: payload });
      else socket.emit(ServerEvents.ERROR, payload);
      done({ ok: false, code: payload.code });
    } catch (replyError) {
      log.error({ event, err: replyError }, "Error reporting a socket error");
    }
  }
}

/** The fields that tie a log line to a battle: room, battle and its correlation id (OBS-1). */
function battleFields(room: Room): LogFields {
  return {
    roomId: room.code,
    battleId: room.battle?.id,
    ...(room.battle?.correlationId ? { correlationId: room.battle.correlationId } : {}),
  };
}

function raceFields(race: { roomCode: string; battleId: string; correlationId?: string }): LogFields {
  return { roomId: race.roomCode, battleId: race.battleId, ...(race.correlationId ? { correlationId: race.correlationId } : {}) };
}

/** From the moment dancing began to the finish; null while the battle runs. */
function battleDurationSeconds(room: Room): number | null {
  const battle = room.battle;
  if (!battle?.finishedAt) return null;
  return Math.max(0, (battle.finishedAt.getTime() - battle.startedAt.getTime()) / 1000);
}
