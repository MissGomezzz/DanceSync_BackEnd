import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";
import { updateRoom } from "../roomUpdates.js";

export interface FinishBattleAtDeadlineInput {
  roomCode: string;
  /** The battle the timer was set for; a newer battle in the same room is left alone. */
  battleId: string;
}

export interface FinishBattleAtDeadlineOutput {
  /** The stored room after the attempt. */
  room: Room;
  /** True when this call finished the battle; the caller must announce it. */
  finished: boolean;
}

/** Called by the battle-end timer; the decision is taken on the latest stored state. */
export class FinishBattleAtDeadline {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Returns null when the room no longer exists. */
  async execute(input: FinishBattleAtDeadlineInput): Promise<FinishBattleAtDeadlineOutput | null> {
    const now = this.clock();
    let finished = false;
    try {
      const room = await updateRoom(this.rooms, input.roomCode, (current) => {
        finished = false;
        if (current.battle?.id !== input.battleId) return current;
        const next = RoomService.finishAtDeadline(current, now);
        finished = next !== current;
        return next;
      });
      return { room, finished };
    } catch (error) {
      if (error instanceof DomainError && error.code === "ROOM_NOT_FOUND") return null;
      throw error;
    }
  }
}
