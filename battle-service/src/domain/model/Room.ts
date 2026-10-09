import type { Battle, BattleResult } from "./Battle.js";
import type { Player } from "./Player.js";
import type { Song } from "./Song.js";
import type { SongSelection } from "./SongSelection.js";

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
  /** Typing challenge that decides who picks the song; null until the host starts one. */
  songSelection: SongSelection | null;
  /** Song chosen through the challenge; the next battle is danced to it. */
  selectedSong: Song | null;
  /**
   * Result of the latest finished battle. Set when a battle finishes and kept
   * across a rematch, so the lobby can show the "Last battle".
   */
  lastResult: BattleResult | null;
  createdAt: Date;
  /**
   * Optimistic concurrency version: 0 when created, +1 on every stored change
   * (see RoomRepository.update). Clients may use it to discard stale updates.
   */
  version: number;
}