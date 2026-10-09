import { randomBytes, randomUUID } from "node:crypto";
import { DomainError } from "../errors/DomainError.js";
import type { Battle, BattleResult } from "../model/Battle.js";
import { MAX_DISPLAY_NAME_LENGTH, MAX_PLAYER_ID_LENGTH, type Player, type PlayerRole } from "../model/Player.js";
import { MAX_SCORE, MIN_SCORE, type Rating } from "../model/Rating.js";
import { MAX_PLAYERS, MIN_DANCERS_PER_BATTLE, type Room } from "../model/Room.js";
import { requireEveryoneReady } from "./readiness.js";
import { isSelectionInProgress, SongSelectionService } from "./SongSelectionService.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const DEFAULT_START_COUNTDOWN_MS = 5000;


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

/** A room code sent by a client; anything that is not non-empty text cannot name a room. */
export function requireRoomCode(code: unknown): string {
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new DomainError("ROOM_NOT_FOUND", "A room code is required");
  }
  return code.trim();
}

function startCountdownMs(): number {
  const fromEnv = process.env.BATTLE_START_COUNTDOWN_MS;
  return fromEnv === undefined ? DEFAULT_START_COUNTDOWN_MS : Number(fromEnv);
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
    const joined: Player = { ...validatePlayer(player.id, player.displayName), role: "undecided", ready: false };
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
   * Removes a player. During a battle the departure can also settle it:
   * - a dancer leaving is withdrawn from the battle; with at least
   *   MIN_DANCERS_PER_BATTLE dancers left the battle goes on, otherwise it ends
   *   early with `result: null`;
   * - a dancer or a spectator leaving can leave every remaining spectator having
   *   rated every remaining dancer, which finishes the battle with a result.
   * Callers detect the end by comparing the status before and after.
   */
  leave(room: Room, playerId: string): Room {
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
    return SongSelectionService.handlePlayerLeft(settleBattleAfterLeave(updated, playerId), playerId);
  },

  /**
   * Starts a battle using whoever currently has role "dancer" (chosen via
   * selectRole), unless explicit dancerIds are given. Anyone still
   * "undecided" at this point becomes a spectator by default. Every player in
   * the room must have marked themselves ready (setReady) and the song must
   * already be chosen (SongSelectionService).
   */
  startBattle(room: Room, dancerIds?: string[]): Room {
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
    const battle: Battle = {
      id: randomUUID(),
      roomCode: room.code,
      dancerIds: dancers.map((d) => d.id),
      song: room.selectedSong,
      ratings: [],
      bonusPoints: Object.fromEntries(dancers.map((d) => [d.id, 0])),
      startedAt: new Date(Date.now() + startCountdownMs()),
      finishedAt: null,
      result: null,
    };
    return {
      ...room,
      players,
      dancers,
      spectators: players.filter((p) => p.role === "spectator"),
      status: "battling",
      battle,
    };
  },

  /**
   * Adds the bonus for a word round won by `playerId`. Only a dancer of the
   * battle in progress earns it; a bonus for a dancer who already left, or after
   * the battle finished, is refused so it can never change a closed result.
   */
  awardWordBonus(room: Room, playerId: string, points: number): Room {
    if (room.status !== "battling" || !room.battle) {
      throw new DomainError("ROOM_NOT_BATTLING", `Room ${room.code} has no battle in progress`);
    }
    if (!room.battle.dancerIds.includes(playerId)) {
      throw new DomainError("INVALID_DANCER", `Player ${playerId} is not dancing in this battle`);
    }
    if (!Number.isInteger(points) || points <= 0) {
      throw new DomainError("INVALID_SCORE", "The bonus must be a positive whole number of points");
    }
    const current = room.battle.bonusPoints[playerId] ?? 0;
    return {
      ...room,
      battle: { ...room.battle, bonusPoints: { ...room.battle.bonusPoints, [playerId]: current + points } },
    };
  },

  rate(room: Room, rating: Omit<Rating, "submittedAt">): Room {
    if (room.status !== "battling" || !room.battle || !room.dancers) {
      throw new DomainError("ROOM_NOT_BATTLING", `Room ${room.code} has no battle in progress`);
    }
    if (!room.spectators.some((s) => s.id === rating.raterId)) {
      throw new DomainError("INVALID_RATER", "Only spectators can rate dancers");
    }
    if (!room.battle.dancerIds.includes(rating.dancerId)) {
      throw new DomainError("INVALID_DANCER", `Player ${rating.dancerId} is not dancing in this battle`);
    }
    if (!Number.isInteger(rating.score) || rating.score < MIN_SCORE || rating.score > MAX_SCORE) {
      throw new DomainError("INVALID_SCORE", `Score must be an integer between ${MIN_SCORE} and ${MAX_SCORE}`);
    }
    if (room.battle.ratings.some((r) => r.raterId === rating.raterId && r.dancerId === rating.dancerId)) {
      throw new DomainError("DUPLICATE_RATING", "This spectator already rated this dancer");
    }
    return {
      ...room,
      battle: {
        ...room.battle,
        ratings: [...room.battle.ratings, { ...rating, submittedAt: new Date() }],
      },
    };
  },

  /**
   * True when every spectator still in the room rated every dancer still in the
   * battle. Ratings from players who left are ignored here, so a departure can
   * neither block nor fake completion.
   */
  allRatingsSubmitted(room: Room): boolean {
    if (!room.battle) return false;
    const { dancerIds, ratings } = room.battle;
    if (room.spectators.length === 0 || dancerIds.length === 0) return false;
    return room.spectators.every((spectator) =>
      dancerIds.every((dancerId) => ratings.some((r) => r.raterId === spectator.id && r.dancerId === dancerId)),
    );
  },

  /**
   * TODO(scoring-HU): a proper tie-break is a separate HU. For now: the highest
   * total (spectators' ratings plus the word race bonus) wins; more than one
   * leader at the top score is reported as a draw (winnerId: null).
   *
   * Only dancers still in the battle (battle.dancerIds) are scored. Ratings a
   * dancer received before leaving stay in battle.ratings as history but do not
   * appear in the result. Ratings from spectators who left still count.
   */
  finishBattle(room: Room): Room {
    if (room.status !== "battling" || !room.battle) {
      throw new DomainError("ROOM_NOT_BATTLING", `Room ${room.code} has no battle in progress`);
    }
    const scores: Record<string, number> = {};
    for (const dancerId of room.battle.dancerIds) scores[dancerId] = 0;
    for (const rating of room.battle.ratings) {
      if (room.battle.dancerIds.includes(rating.dancerId)) scores[rating.dancerId] += rating.score;
    }
    for (const dancerId of room.battle.dancerIds) scores[dancerId] += room.battle.bonusPoints[dancerId] ?? 0;
    const maxScore = Math.max(...Object.values(scores));
    const leaders = room.battle.dancerIds.filter((id) => scores[id] === maxScore);
    const result: BattleResult = { scores, winnerId: leaders.length === 1 ? leaders[0] : null };
    return {
      ...room,
      status: "finished",
      battle: { ...room.battle, finishedAt: new Date(), result },
    };
  },
};
/**
 * Applies a departure (already removed from players/dancers/spectators) to a
 * running battle. A departed dancer is dropped from battle.dancerIds, so they
 * can no longer be rated and no rating for them is required; ratings they
 * already received are kept in battle.ratings but excluded from the result.
 */
function settleBattleAfterLeave(room: Room, playerId: string): Room {
  const battle = room.battle;
  if (room.status !== "battling" || !battle) return room;
  const remaining: Battle = { ...battle, dancerIds: battle.dancerIds.filter((id) => id !== playerId) };
  if (remaining.dancerIds.length < MIN_DANCERS_PER_BATTLE) {
    // Not enough dancers to keep competing: the battle ends early, without a result.
    return { ...room, status: "finished", battle: { ...remaining, finishedAt: new Date(), result: null } };
  }
  const continuing: Room = { ...room, battle: remaining };
  return RoomService.allRatingsSubmitted(continuing) ? RoomService.finishBattle(continuing) : continuing;
}
