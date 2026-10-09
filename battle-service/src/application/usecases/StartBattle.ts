import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService, type StartBattleOptions } from "../../domain/services/RoomService.js";
import { updateRoom } from "../roomUpdates.js";

export interface StartBattleInput {
  roomCode: string;
  /** Player requesting the start; must be the room host. */
  requesterId: string;
  /** Overrides the dancers chosen through role:select; at least MIN_DANCERS_PER_BATTLE ids. */
  dancerIds?: string[];
}

/** Battle timing injected from the configuration (config/env.ts); `now` is taken per command. */
export type BattleTimingOptions = Omit<StartBattleOptions, "now">;

export class StartBattle {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly timing: BattleTimingOptions = {},
  ) {}

  async execute(input: StartBattleInput): Promise<Room> {
    return updateRoom(this.rooms, input.roomCode, (room) => {
      if (room.hostId !== input.requesterId) {
        throw new DomainError("NOT_HOST", "Only the host can start the battle");
      }
      return RoomService.startBattle(room, input.dancerIds, { ...this.timing, now: new Date() });
    });
  }
}
