import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";
import { updateRoom } from "../roomUpdates.js";

export interface StartRematchInput {
  roomCode: string;
  /** Player asking for the rematch; must be the room host. */
  requesterId: string;
}

export interface StartRematchOutput {
  room: Room;
  /** Spectators who had a vote in the battle just replaced; their vote is now cleared. */
  clearedVoterIds: string[];
}

/** The host takes a finished room back to the lobby for another battle (HU 18). */
export class StartRematch {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: StartRematchInput): Promise<StartRematchOutput> {
    let clearedVoterIds: string[] = [];
    const room = await updateRoom(this.rooms, input.roomCode, (current) => {
      const next = RoomService.rematch(current, input.requesterId);
      clearedVoterIds = Object.keys(current.battle?.votes ?? {}).filter((id) => next.players.some((p) => p.id === id));
      return next;
    });
    return { room, clearedVoterIds };
  }
}
