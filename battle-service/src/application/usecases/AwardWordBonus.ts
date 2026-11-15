import type { Room } from "../../domain/model/Room.js";
import type { WordRace } from "../../domain/model/WordRace.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";
import { updateRoom } from "../roomUpdates.js";

export interface AwardWordBonusInput {
  roomCode: string;
  /** The dancer who won the word round. */
  playerId: string;
  /** The round won: makes the bonus idempotent (paid once per round, whoever pays it). */
  roundId?: string;
}

export interface ReconcileWordBonusesOutput {
  /** The room after the update; null when the race has no won round (nothing was read). */
  room: Room | null;
  /** Rounds paid by this call; empty when every won round was already paid. */
  paidRoundIds: string[];
}

/**
 * Counts a word round won by the winner (battle.wordsWon); the points it is
 * worth come from the battle's scoring snapshot. Called by the one submission
 * that won the atomic claim and, as a safety net, by `reconcile` on any replica
 * (DIS-1): both pay per round id, so a round is counted only once.
 */
export class AwardWordBonus {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: AwardWordBonusInput): Promise<Room> {
    return updateRoom(this.rooms, input.roomCode, (room) =>
      RoomService.awardWordBonus(room, input.playerId, input.roundId),
    );
  }

  /**
   * Pays the bonus of every round of `race` that was won but not paid yet (the
   * replica that won the claim died before paying it). One atomic room update;
   * no write at all when there is nothing to pay.
   */
  async reconcile(race: WordRace): Promise<ReconcileWordBonusesOutput> {
    const won = race.rounds.flatMap((r) => (r.status === "won" && r.winnerId ? [{ roundId: r.id, winnerId: r.winnerId }] : []));
    if (won.length === 0) return { room: null, paidRoundIds: [] };
    let paidRoundIds: string[] = [];
    const room = await updateRoom(this.rooms, race.roomCode, (current) => {
      const before = new Set(current.battle?.wordRoundsAwarded ?? []);
      const next = RoomService.reconcileWordBonuses(current, race.battleId, won);
      paidRoundIds = (next.battle?.wordRoundsAwarded ?? []).filter((id) => !before.has(id));
      return next;
    });
    return { room, paidRoundIds };
  }
}
