import { randomBytes, randomUUID } from "node:crypto";
import { DomainError } from "../errors/DomainError.js";
import type { Battle, BattleResult } from "../model/Battle.js";
import type { Player, PlayerRole } from "../model/Player.js";
import { MAX_SCORE, MIN_SCORE, type Rating } from "../model/Rating.js";
import { MAX_PLAYERS, MIN_DANCERS_PER_BATTLE, type Room } from "../model/Room.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

export const RoomService = {
  create(host: Omit<Player, "role">, code: string = generateRoomCode()): Room {
    const hostPlayer: Player = { ...host, role: "undecided" };
    return {
      code,
      hostId: host.id,
      players: [hostPlayer],
      dancers: null,
      spectators: [],
      status: "waiting",
      battle: null,
      createdAt: new Date(),
    };
  },

  join(room: Room, player: Omit<Player, "role">): Room {
    if (room.status !== "waiting") {
      throw new DomainError("ROOM_NOT_WAITING", `Room ${room.code} is not accepting players`);
    }
    if (room.players.some((p) => p.id === player.id)) {
      throw new DomainError("PLAYER_ALREADY_IN_ROOM", `Player ${player.id} is already in room ${room.code}`);
    }
    if (room.players.length >= MAX_PLAYERS) {
      throw new DomainError("ROOM_FULL", `Room ${room.code} already has ${MAX_PLAYERS} players`);
    }
    const joined: Player = { ...player, role: "undecided" };
    return { ...room, players: [...room.players, joined] };
  },

  /** Sets a player's chosen role while the room is still in the lobby. */
  selectRole(room: Room, playerId: string, role: Exclude<PlayerRole, "undecided">): Room {
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

  leave(room: Room, playerId: string): Room {
    if (!room.players.some((p) => p.id === playerId)) {
      throw new DomainError("PLAYER_NOT_IN_ROOM", `Player ${playerId} is not in room ${room.code}`);
    }
    const players = room.players.filter((p) => p.id !== playerId);
    const dancers = room.dancers && room.dancers.some((d) => d.id === playerId) ? null : room.dancers;
    return {
      ...room,
      players,
      dancers,
      spectators: players.filter((p) => !dancers || !dancers.some((d) => d.id === p.id)),
      hostId: room.hostId === playerId ? (players[0]?.id ?? room.hostId) : room.hostId,
      status: room.status === "battling" && dancers === null ? "finished" : room.status,
    };
  },

  /**
   * Starts a battle using whoever currently has role "dancer" (chosen via
   * selectRole), unless explicit dancerIds are given. Anyone still
   * "undecided" at this point becomes a spectator by default.
   */
  startBattle(room: Room, dancerIds?: string[]): Room {
    if (room.status !== "waiting") {
      throw new DomainError("ROOM_NOT_WAITING", `Room ${room.code} already started`);
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

    const dancers = selected.map((p) => ({ ...p!, role: "dancer" as const }));
    const players = room.players.map((p) => {
      const isDancer = dancers.some((d) => d.id === p.id);
      return isDancer ? { ...p, role: "dancer" as const } : { ...p, role: "spectator" as const };
    });
    const battle: Battle = {
      id: randomUUID(),
      roomCode: room.code,
      dancerIds: dancers.map((d) => d.id),
      ratings: [],
      startedAt: new Date(),
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

  allRatingsSubmitted(room: Room): boolean {
    if (!room.battle) return false;
    const expected = room.spectators.length * room.battle.dancerIds.length;
    return expected > 0 && room.battle.ratings.length >= expected;
  },

  /**
   * TODO(scoring-HU): winner-by-score with a proper tie-break (mid-song bonuses)
   * is a separate HU. For now: highest total score wins; more than one leader
   * at the top score is reported as a draw (winnerId: null).
   */
  finishBattle(room: Room): Room {
    if (room.status !== "battling" || !room.battle) {
      throw new DomainError("ROOM_NOT_BATTLING", `Room ${room.code} has no battle in progress`);
    }
    const scores: Record<string, number> = {};
    for (const dancerId of room.battle.dancerIds) scores[dancerId] = 0;
    for (const rating of room.battle.ratings) {
      scores[rating.dancerId] = (scores[rating.dancerId] ?? 0) + rating.score;
    }
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