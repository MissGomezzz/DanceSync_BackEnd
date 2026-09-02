import { randomBytes, randomUUID } from "node:crypto";
import { DomainError } from "../errors/DomainError.js";
import type { Battle, BattleResult } from "../model/Battle.js";
import type { Player } from "../model/Player.js";
import { MAX_SCORE, MIN_SCORE, type Rating } from "../model/Rating.js";
import { DANCERS_PER_BATTLE, MAX_PLAYERS, type Room } from "../model/Room.js";

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

/**
 * Pure room rules. Every function returns a new Room and never mutates its input,
 * so use cases stay trivially testable and persistence remains an adapter concern.
 */
export const RoomService = {
  create(host: Omit<Player, "role">, code: string = generateRoomCode()): Room {
    const hostPlayer: Player = { ...host, role: "spectator" };
    return {
      code,
      hostId: host.id,
      players: [hostPlayer],
      dancers: null,
      spectators: [hostPlayer],
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
    const joined: Player = { ...player, role: "spectator" };
    return {
      ...room,
      players: [...room.players, joined],
      spectators: [...room.spectators, joined],
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
      // A battle cannot continue without both dancers.
      status: room.status === "battling" && dancers === null ? "finished" : room.status,
    };
  },

  /**
   * Starts a battle. When dancer ids are omitted the first two players who joined
   * become dancers; everyone else spectates.
   */
  startBattle(room: Room, dancerIds?: [string, string]): Room {
    if (room.status !== "waiting") {
      throw new DomainError("ROOM_NOT_WAITING", `Room ${room.code} already started`);
    }
    if (room.players.length < DANCERS_PER_BATTLE) {
      throw new DomainError("NOT_ENOUGH_PLAYERS", `Room ${room.code} needs ${DANCERS_PER_BATTLE} players to start`);
    }
    const selectedIds = dancerIds ?? [room.players[0]!.id, room.players[1]!.id];
    if (selectedIds[0] === selectedIds[1]) {
      throw new DomainError("INVALID_DANCER", "Both dancers must be different players");
    }
    const selected = selectedIds.map((id) => room.players.find((p) => p.id === id));
    if (selected.some((p) => p === undefined)) {
      throw new DomainError("INVALID_DANCER", "Selected dancers must be players in the room");
    }

    const dancers = selected.map((p) => ({ ...p!, role: "dancer" as const })) as [Player, Player];
    const players = room.players.map((p) => {
      const dancer = dancers.find((d) => d.id === p.id);
      return dancer ?? { ...p, role: "spectator" as const };
    });
    const battle: Battle = {
      id: randomUUID(),
      roomCode: room.code,
      dancerIds: [dancers[0].id, dancers[1].id],
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

  /** True once every spectator has rated both dancers. */
  allRatingsSubmitted(room: Room): boolean {
    if (!room.battle) return false;
    const expected = room.spectators.length * DANCERS_PER_BATTLE;
    return expected > 0 && room.battle.ratings.length >= expected;
  },

  finishBattle(room: Room): Room {
    if (room.status !== "battling" || !room.battle) {
      throw new DomainError("ROOM_NOT_BATTLING", `Room ${room.code} has no battle in progress`);
    }
    const scores: Record<string, number> = {};
    for (const dancerId of room.battle.dancerIds) scores[dancerId] = 0;
    for (const rating of room.battle.ratings) {
      scores[rating.dancerId] = (scores[rating.dancerId] ?? 0) + rating.score;
    }
    const [first, second] = room.battle.dancerIds;
    const result: BattleResult = {
      scores,
      winnerId:
        scores[first]! === scores[second]! ? null : scores[first]! > scores[second]! ? first : second,
    };
    return {
      ...room,
      status: "finished",
      battle: { ...room.battle, finishedAt: new Date(), result },
    };
  },
};
