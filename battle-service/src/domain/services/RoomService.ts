import { randomBytes, randomUUID } from "node:crypto";
import { DomainError } from "../errors/DomainError.js";
import {
  DEFAULT_VOTE_POINTS,
  DEFAULT_WORD_BONUS_POINTS,
  type Battle,
  type BattleEndReason,
  type ScoringPoints,
} from "../model/Battle.js";
import { MAX_DISPLAY_NAME_LENGTH, MAX_PLAYER_ID_LENGTH, type Player, type PlayerRole } from "../model/Player.js";
import { MAX_PLAYERS, MIN_DANCERS_PER_BATTLE, type Room } from "../model/Room.js";
import { DEFAULT_WORD_FALLBACK_DURATION_MS } from "../model/WordRace.js";
import { requireEveryoneReady } from "./readiness.js";
import { ScoringService } from "./ScoringService.js";
import { isSelectionInProgress, secureRandomIndex, SongSelectionService } from "./SongSelectionService.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;

/**
 * Countdown used when the caller configures none. The running service injects
 * BATTLE_START_COUNTDOWN_MS (5 s by default, see config/env.ts); the domain
 * itself never reads the environment.
 */
export const DEFAULT_START_COUNTDOWN_MS = 0;

export interface StartBattleOptions {
  /** Moment of the start command; defaults to the current time. */
  now?: Date;
  /** Delay between the start command and battle.startedAt, in ms (0 or more). */
  countdownMs?: number;
  /** Song length assumed when the battle has no song, in ms. */
  fallbackDurationMs?: number;
  /** Points per vote and per word won; snapshotted into the battle. */
  scoring?: ScoringPoints;
}

export const DEFAULT_SCORING: ScoringPoints = {
  votePoints: DEFAULT_VOTE_POINTS,
  wordBonusPoints: DEFAULT_WORD_BONUS_POINTS,
};

export function generateRoomCode(): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Validates an identity coming from a client (room:join, POST /api/rooms) and
 * returns it normalized. The id must be text of 1-64 characters without
 * surrounding whitespace: it is compared verbatim on every later event, so it is
 * rejected rather than trimmed into a different id. The display name is trimmed
 * and must keep 1-32 characters.
 */
export function validatePlayer(id: unknown, displayName: unknown): Omit<Player, "role" | "ready"> {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_PLAYER_ID_LENGTH || id.trim() !== id) {
    throw new DomainError(
      "INVALID_PLAYER",
      `The player id must be 1-${MAX_PLAYER_ID_LENGTH} characters without surrounding spaces`,
    );
  }
  const name = typeof displayName === "string" ? displayName.trim() : "";
  if (name.length === 0 || name.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new DomainError("INVALID_PLAYER", `The display name must be 1-${MAX_DISPLAY_NAME_LENGTH} characters`);
  }
  return { id, displayName: name };
}

/**
 * Makes a display name unique within the room (HU 19): a name already used by
 * another player, ignoring case, gets the first free suffix " 2", " 3", ...
 * The base is shortened when needed so the result still fits
 * MAX_DISPLAY_NAME_LENGTH.
 */
export function uniqueDisplayName(players: readonly Pick<Player, "displayName">[], displayName: string): string {
  const taken = new Set(players.map((p) => p.displayName.toLocaleLowerCase()));
  if (!taken.has(displayName.toLocaleLowerCase())) return displayName;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const base = displayName.slice(0, MAX_DISPLAY_NAME_LENGTH - suffix.length).trimEnd();
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

/** A room code sent by a client; anything that is not non-empty text cannot name a room. */
export function requireRoomCode(code: unknown): string {
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new DomainError("ROOM_NOT_FOUND", "A room code is required");
  }
  return code.trim();
}

const PLAYABLE_ROLES: readonly string[] = ["dancer", "spectator"] satisfies PlayerRole[];

export const RoomService = {
  create(host: Omit<Player, "role" | "ready">, code: string = generateRoomCode()): Room {
    const hostPlayer: Player = { ...validatePlayer(host.id, host.displayName), role: "undecided", ready: false };
    return {
      code,
      hostId: hostPlayer.id,
      players: [hostPlayer],
      dancers: null,
      spectators: [],
      status: "waiting",
      battle: null,
      songSelection: null,
      selectedSong: null,
      lastResult: null,
      createdAt: new Date(),
      version: 0,
    };
  },

  join(room: Room, player: Omit<Player, "role" | "ready">): Room {
    if (room.status !== "waiting") {
      throw new DomainError("ROOM_NOT_WAITING", `Room ${room.code} is not accepting players`);
    }
    if (room.players.some((p) => p.id === player.id)) {
      throw new DomainError("PLAYER_ALREADY_IN_ROOM", `Player ${player.id} is already in room ${room.code}`);
    }
    if (room.players.length >= MAX_PLAYERS) {
      throw new DomainError("ROOM_FULL", `Room ${room.code} already has ${MAX_PLAYERS} players`);
    }
    const valid = validatePlayer(player.id, player.displayName);
    const joined: Player = {
      ...valid,
      displayName: uniqueDisplayName(room.players, valid.displayName),
      role: "undecided",
      ready: false,
    };
    return { ...room, players: [...room.players, joined] };
  },

  /** Sets a player's chosen role while the room is still in the lobby. */
  selectRole(room: Room, playerId: string, role: Exclude<PlayerRole, "undecided">): Room {
    // Clients send the role over the wire: check it at runtime, not only in the type.
    if (!PLAYABLE_ROLES.includes(role)) {
      throw new DomainError("INVALID_MESSAGE", 'The role must be "dancer" or "spectator"');
    }
    if (room.status !== "waiting") {
      throw new DomainError("ROOM_NOT_WAITING", `Room ${room.code} is not accepting role changes`);
    }
    if (!room.players.some((p) => p.id === playerId)) {
      throw new DomainError("PLAYER_NOT_IN_ROOM", `Player ${playerId} is not in room ${room.code}`);
    }
    const players = room.players.map((p) => (p.id === playerId ? { ...p, role } : p));
    return {
      ...room,
      players,
      spectators: players.filter((p) => p.role === "spectator"),
    };
  },

  /**
   * Marks a player as ready (or not ready) to dance. Setting the state a player
   * already has is accepted and changes nothing, so a repeated or retried
   * request never flips the state back.
   */
  setReady(room: Room, playerId: string, ready: boolean): Room {
    // Clients send the flag over the wire: check it at runtime, not only in the type.
    if (typeof ready !== "boolean") {
      throw new DomainError("INVALID_MESSAGE", "ready must be true or false");
    }
    if (room.status !== "waiting") {
      throw new DomainError("ROOM_NOT_WAITING", `Room ${room.code} is not accepting ready changes`);
    }
    if (!room.players.some((p) => p.id === playerId)) {
      throw new DomainError("PLAYER_NOT_IN_ROOM", `Player ${playerId} is not in room ${room.code}`);
    }
    const players = room.players.map((p) => (p.id === playerId ? { ...p, ready } : p));
    return {
      ...room,
      players,
      spectators: players.filter((p) => p.role === "spectator"),
    };
  },

  /**
   * Removes a player. During a battle the departure also settles it:
   * - a spectator leaving loses their vote;
   * - a dancer leaving is withdrawn from the battle and the votes for them are
   *   discarded (those spectators can vote again); with fewer than
   *   MIN_DANCERS_PER_BATTLE dancers left the battle ends early
   *   ("not-enough-dancers") with a result over the dancers who stayed.
   * Callers detect the end by comparing the status before and after.
   */
  leave(room: Room, playerId: string, now: Date = new Date()): Room {
    if (!room.players.some((p) => p.id === playerId)) {
      throw new DomainError("PLAYER_NOT_IN_ROOM", `Player ${playerId} is not in room ${room.code}`);
    }
    const players = room.players.filter((p) => p.id !== playerId);
    const updated: Room = {
      ...room,
      players,
      dancers: room.dancers ? room.dancers.filter((d) => d.id !== playerId) : null,
      spectators: room.spectators.filter((p) => p.id !== playerId),
      hostId: room.hostId === playerId ? (players[0]?.id ?? room.hostId) : room.hostId,
    };
    return SongSelectionService.handlePlayerLeft(
      settleBattleAfterLeave(updated, playerId, now),
      playerId,
      secureRandomIndex,
      now,
    );
  },

  /**
   * The host removes another player from the lobby. Every player must be ready
   * before the song selection or the battle can start, so one idle player would
   * otherwise hold the whole room. The kicked player leaves through the normal
   * departure rules (a song chooser's turn is passed on, and so on).
   */
  kick(room: Room, requesterId: string, playerId: string, now: Date = new Date()): Room {
    if (room.hostId !== requesterId) {
      throw new DomainError("NOT_HOST", "Only the host can remove players");
    }
    if (room.status !== "waiting") {
      throw new DomainError("ROOM_NOT_WAITING", `Players can only be removed from room ${room.code} in the lobby`);
    }
    if (typeof playerId !== "string" || playerId === requesterId) {
      throw new DomainError("INVALID_PLAYER", "Choose another player of the room to remove");
    }
    if (!room.players.some((p) => p.id === playerId)) {
      throw new DomainError("PLAYER_NOT_IN_ROOM", `Player ${playerId} is not in room ${room.code}`);
    }
    return RoomService.leave(room, playerId, now);
  },

  /**
   * Starts a battle using whoever currently has role "dancer" (chosen via
   * selectRole), unless explicit dancerIds are given. Anyone still
   * "undecided" at this point becomes a spectator by default. Every player in
   * the room must have marked themselves ready (setReady) and the song must
   * already be chosen (SongSelectionService).
   */
  startBattle(room: Room, dancerIds?: string[], options: StartBattleOptions = {}): Room {
    const {
      now = new Date(),
      countdownMs = DEFAULT_START_COUNTDOWN_MS,
      fallbackDurationMs = DEFAULT_WORD_FALLBACK_DURATION_MS,
      scoring = DEFAULT_SCORING,
    } = options;
    for (const [name, value] of [
      ["start countdown", countdownMs],
      ["fallback song length", fallbackDurationMs],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) throw new RangeError(`The ${name} must be 0 ms or more, received ${value}`);
    }
    for (const [name, value] of Object.entries(scoring)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a whole number of 0 or more, received ${value}`);
      }
    }
    if (room.status !== "waiting") {
      throw new DomainError("ROOM_NOT_WAITING", `Room ${room.code} already started`);
    }
    if (isSelectionInProgress(room)) {
      throw new DomainError("SONG_SELECTION_IN_PROGRESS", "Wait until the song has been chosen");
    }
    const explicit: unknown = dancerIds;
    if (explicit != null && (!Array.isArray(explicit) || explicit.some((id) => typeof id !== "string"))) {
      throw new DomainError("INVALID_DANCER", "dancerIds must be a list of player ids");
    }
    const selectedIds = dancerIds ?? room.players.filter((p) => p.role === "dancer").map((p) => p.id);
    if (new Set(selectedIds).size !== selectedIds.length) {
      throw new DomainError("INVALID_DANCER", "Dancer ids must be unique");
    }
    if (selectedIds.length < MIN_DANCERS_PER_BATTLE) {
      throw new DomainError(
        "NOT_ENOUGH_DANCERS",
        `At least ${MIN_DANCERS_PER_BATTLE} dancers are required to start`,
      );
    }
    const selected = selectedIds.map((id) => room.players.find((p) => p.id === id));
    if (selected.some((p) => p === undefined)) {
      throw new DomainError("INVALID_DANCER", "Selected dancers must be players in the room");
    }

    requireEveryoneReady(room);
    if (!room.selectedSong) {
      throw new DomainError("SONG_NOT_SELECTED", "Choose the song before starting the battle");
    }

    const dancers = selected.map((p) => ({ ...p!, role: "dancer" as const }));
    const players = room.players.map((p) => {
      const isDancer = dancers.some((d) => d.id === p.id);
      return isDancer ? { ...p, role: "dancer" as const } : { ...p, role: "spectator" as const };
    });
    const spectators = players.filter((p) => p.role === "spectator");
    const startedAt = now.getTime() + countdownMs;
    const songMs = room.selectedSong ? room.selectedSong.durationSeconds * 1000 : fallbackDurationMs;
    const battle: Battle = {
      id: randomUUID(),
      roomCode: room.code,
      dancerIds: dancers.map((d) => d.id),
      roster: dancers.map((d) => ({ id: d.id, displayName: d.displayName })),
      audience: spectators.map((s) => ({ id: s.id, displayName: s.displayName })),
      song: room.selectedSong,
      votes: {},
      wordsWon: Object.fromEntries(dancers.map((d) => [d.id, 0])),
      scoring: { votePoints: scoring.votePoints, wordBonusPoints: scoring.wordBonusPoints },
      startedAt: new Date(startedAt),
      // The battle lasts exactly the song clip; votes count until then.
      endsAt: new Date(startedAt + songMs),
      finishedAt: null,
      endReason: null,
      result: null,
    };
    return {
      ...room,
      players,
      dancers,
      spectators,
      status: "battling",
      battle,
    };
  },

  /**
   * Counts a word round won by `playerId`. Only a dancer of the battle in
   * progress earns it; a win for a dancer who already left, or after the battle
   * finished, is refused so it can never change a closed result.
   */
  awardWordBonus(room: Room, playerId: string): Room {
    if (room.status !== "battling" || !room.battle) {
      throw new DomainError("ROOM_NOT_BATTLING", `Room ${room.code} has no battle in progress`);
    }
    if (!room.battle.dancerIds.includes(playerId)) {
      throw new DomainError("INVALID_DANCER", `Player ${playerId} is not dancing in this battle`);
    }
    const current = room.battle.wordsWon[playerId] ?? 0;
    return {
      ...room,
      battle: { ...room.battle, wordsWon: { ...room.battle.wordsWon, [playerId]: current + 1 } },
    };
  },

  /**
   * A spectator votes for their favourite dancer (HU 20): `dancerId` casts or
   * moves the vote, null withdraws it. One vote per spectator, accepted from
   * the moment the dancing begins (battle.startedAt) until the song ends
   * (battle.endsAt). The decision is taken on the state being stored, so a vote
   * racing the end of the song either counts (before endsAt) or is refused.
   * Casting the vote a spectator already has, or withdrawing none, returns the
   * very same room (nothing to store).
   */
  castVote(room: Room, voterId: string, dancerId: string | null, now: Date = new Date()): Room {
    const battle = room.battle;
    if (room.status === "finished" && battle) {
      throw new DomainError("BATTLE_FINISHED", "The battle is over; votes are closed");
    }
    if (room.status !== "battling" || !battle) {
      throw new DomainError("ROOM_NOT_BATTLING", `Room ${room.code} has no battle in progress`);
    }
    if (!room.spectators.some((s) => s.id === voterId)) {
      throw new DomainError("INVALID_VOTER", "Only the spectators of the battle can vote");
    }
    if (now.getTime() < battle.startedAt.getTime()) {
      throw new DomainError("BATTLE_NOT_STARTED", "The battle has not started yet; vote once the dancing begins");
    }
    if (now.getTime() >= battle.endsAt.getTime()) {
      throw new DomainError("BATTLE_FINISHED", "The song is over; votes are closed");
    }
    // Clients send the dancer over the wire: check it at runtime, not only in the type.
    const wanted: unknown = dancerId;
    if (wanted !== null && typeof wanted !== "string") {
      throw new DomainError("INVALID_MESSAGE", "dancerId must be a dancer id, or null to withdraw the vote");
    }
    if (wanted !== null && !battle.dancerIds.includes(wanted)) {
      throw new DomainError("INVALID_DANCER", `Player ${wanted} is not dancing in this battle`);
    }
    const current = battle.votes[voterId] ?? null;
    if (current === wanted) return room;
    const votes = { ...battle.votes };
    if (wanted === null) delete votes[voterId];
    else votes[voterId] = wanted;
    return { ...room, battle: { ...battle, votes } };
  },

  /** The spectator's current vote in the room's battle, or null. */
  voteOf(room: Room, voterId: string): string | null {
    return room.battle?.votes[voterId] ?? null;
  },

  /**
   * Closes the battle: votes freeze and the result is computed over the dancers
   * still in it (ScoringService), then also kept as the room's lastResult.
   */
  finishBattle(room: Room, reason: BattleEndReason, now: Date = new Date()): Room {
    if (room.status !== "battling" || !room.battle) {
      throw new DomainError("ROOM_NOT_BATTLING", `Room ${room.code} has no battle in progress`);
    }
    const result = ScoringService.result(room.battle);
    return {
      ...room,
      status: "finished",
      battle: { ...room.battle, finishedAt: now, endReason: reason, result },
      lastResult: result,
    };
  },

  /**
   * Finishes a battle still running once the song clip ended (battle.endsAt),
   * with the votes and words collected until then. Returns the very same room
   * when there is nothing to do (not battling, or the song is not over yet).
   */
  finishAtDeadline(room: Room, now: Date): Room {
    const battle = room.battle;
    if (room.status !== "battling" || !battle || now.getTime() < battle.endsAt.getTime()) return room;
    return RoomService.finishBattle(room, "song-end", now);
  },

  /**
   * The host takes a finished room back to the lobby for another battle with
   * the same players (HU 18): roles are kept, everyone's ready flag resets, the
   * song has to be chosen again, and the result just played stays available as
   * lastResult.
   */
  rematch(room: Room, requesterId: string): Room {
    if (room.hostId !== requesterId) {
      throw new DomainError("NOT_HOST", "Only the host can start a rematch");
    }
    if (room.status !== "finished") {
      throw new DomainError("ROOM_NOT_FINISHED", `Room ${room.code} has no finished battle to replay`);
    }
    const players = room.players.map((p) => ({ ...p, ready: false }));
    return {
      ...room,
      players,
      dancers: null,
      spectators: players.filter((p) => p.role === "spectator"),
      status: "waiting",
      battle: null,
      songSelection: null,
      selectedSong: null,
      lastResult: room.battle?.result ?? room.lastResult,
    };
  },
};

/**
 * Applies a departure (already removed from players/dancers/spectators) to a
 * running battle: the leaver's own vote is dropped, and a departed dancer is
 * withdrawn from battle.dancerIds with every vote for them discarded.
 */
function settleBattleAfterLeave(room: Room, playerId: string, now: Date): Room {
  const battle = room.battle;
  if (room.status !== "battling" || !battle) return room;
  const votes = Object.fromEntries(
    Object.entries(battle.votes).filter(([voterId, dancerId]) => voterId !== playerId && dancerId !== playerId),
  );
  const remaining: Battle = { ...battle, dancerIds: battle.dancerIds.filter((id) => id !== playerId), votes };
  const continuing: Room = { ...room, battle: remaining };
  // Not enough dancers left to keep competing: the battle ends early.
  return remaining.dancerIds.length < MIN_DANCERS_PER_BATTLE
    ? RoomService.finishBattle(continuing, "not-enough-dancers", now)
    : continuing;
}
