import type { Battle } from "../../domain/model/Battle.js";
import type { Room } from "../../domain/model/Room.js";
import type { SongChallenge, SongSelection } from "../../domain/model/SongSelection.js";

/**
 * Wire shape of a room: the stored Room plus relative times computed by the
 * server at the moment it is sent. Clients count down from these values and
 * never compare their own clock with the server's absolute dates.
 */
export interface SongSelectionDto extends Omit<SongSelection, "challenge"> {
  challenge: SongChallenge & {
    /** Time left to type the phrase, never negative. */
    expiresInMs: number;
  };
  /** Time the current chooser has left to pick (never negative) while phase is "choosing"; null otherwise. */
  chooseExpiresInMs: number | null;
}

export interface BattleDto extends Battle {
  /** Time until the dancing begins; negative once it began (elapsed time). */
  startsInMs: number;
}

export interface RoomDto extends Omit<Room, "songSelection" | "battle"> {
  songSelection: SongSelectionDto | null;
  battle: BattleDto | null;
}

/**
 * The single serializer for every Room the server sends: room:updated,
 * battle:started, battle:finished, every ack returning a room, the join resync
 * and the HTTP API. Keeps every stored field and adds the relative times.
 */
export function toRoomDto(room: Room, now: Date): RoomDto {
  const at = now.getTime();
  const { songSelection, battle } = room;
  return {
    ...room,
    songSelection: songSelection
      ? {
          ...songSelection,
          challenge: {
            ...songSelection.challenge,
            expiresInMs: Math.max(0, songSelection.challenge.expiresAt.getTime() - at),
          },
          chooseExpiresInMs:
            songSelection.phase === "choosing" && songSelection.chooseDeadline
              ? Math.max(0, songSelection.chooseDeadline.getTime() - at)
              : null,
        }
      : null,
    battle: battle ? { ...battle, startsInMs: battle.startedAt.getTime() - at } : null,
  };
}

export function toRoomDtoOrNull(room: Room | null, now: Date): RoomDto | null {
  return room ? toRoomDto(room, now) : null;
}
