import type { Battle, Standing } from "../../domain/model/Battle.js";
import type { Room } from "../../domain/model/Room.js";
import type { SongChallenge, SongSelection } from "../../domain/model/SongSelection.js";
import { ScoringService } from "../../domain/services/ScoringService.js";

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

/**
 * The battle without `votes`: who voted for whom never leaves the server (each
 * spectator learns their own vote through vote:mine). Only totals are sent.
 */
export interface BattleDto extends Omit<Battle, "votes"> {
  /** Time until the dancing begins; negative once it began (elapsed time). */
  startsInMs: number;
  /** Time until the battle finishes on its own (battle.endsAt) while it runs; null once finished. */
  endsInMs: number | null;
  /** Ranking of the dancers still in the battle, best first: live while it runs, then the final one. */
  standings: Standing[];
  /** Current (then final) votes per dancer still in the battle. */
  voteCounts: Record<string, number>;
}

export interface RoomDto extends Omit<Room, "songSelection" | "battle"> {
  songSelection: SongSelectionDto | null;
  battle: BattleDto | null;
}

/**
 * The single serializer for every Room the server sends: room:updated,
 * battle:started, battle:finished, every ack returning a room, the join resync
 * and the HTTP API. Keeps every stored field except the raw votes, and adds the
 * relative times and the scoring computed from the state being sent.
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
    battle: battle ? toBattleDto(battle, room.status === "battling", at) : null,
  };
}

function toBattleDto(battle: Battle, running: boolean, at: number): BattleDto {
  const { votes: _private, ...visible } = battle;
  // A finished battle shows its frozen result; a running one is scored live.
  const standings = battle.result ? battle.result.standings : ScoringService.standings(battle);
  return {
    ...visible,
    startsInMs: battle.startedAt.getTime() - at,
    endsInMs: running ? battle.endsAt.getTime() - at : null,
    standings,
    voteCounts: Object.fromEntries(standings.map((s) => [s.dancerId, s.votes])),
  };
}

export function toRoomDtoOrNull(room: Room | null, now: Date): RoomDto | null {
  return room ? toRoomDto(room, now) : null;
}
