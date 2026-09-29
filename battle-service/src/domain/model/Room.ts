import type { Battle } from "./Battle.js";
import type { Player } from "./Player.js";

/** Maximum number of participants per room: 2 dancers + 5 spectators. */
export const MAX_PLAYERS = 7;
export const DANCERS_PER_BATTLE = 2;

export type RoomStatus = "waiting" | "battling" | "finished";

export interface Room {
  code: string;
  hostId: string;
  players: Player[];
  dancers: [Player, Player] | null;
  spectators: Player[];
  status: RoomStatus;
  battle: Battle | null;
  createdAt: Date;
}
