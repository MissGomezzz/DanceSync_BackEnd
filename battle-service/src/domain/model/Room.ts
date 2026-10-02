import type { Battle } from "./Battle.js";
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
  createdAt: Date;
}