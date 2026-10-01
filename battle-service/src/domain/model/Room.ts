import type { Battle } from "./Battle.js";
import type { Player } from "./Player.js";

export const MAX_PLAYERS = 7;
/** Minimum dancers required to start a battle; there is no fixed maximum yet. */
export const MIN_DANCERS_PER_BATTLE = 2;

export type RoomStatus = "waiting" | "battling" | "finished";

export interface Room {
  code: string;
  hostId: string;
  players: Player[];
  dancers: Player[] | null;
  spectators: Player[];
  status: RoomStatus;
  battle: Battle | null;
  createdAt: Date;
}