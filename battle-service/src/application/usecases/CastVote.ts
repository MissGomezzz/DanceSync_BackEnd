import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";
import { updateRoom } from "../roomUpdates.js";

export interface CastVoteInput {
  roomCode: string;
  voterId: string;
  /** The dancer voted for, or null to withdraw the vote. */
  dancerId: string | null;
}

export interface CastVoteOutput {
  /** The stored room after the vote. */
  room: Room;
  /** The voter's current vote, as stored. */
  dancerId: string | null;
  /** False when the vote was already the stored one (nothing was written). */
  changed: boolean;
}

/**
 * A spectator casts, moves or withdraws their vote (HU 20). The rule runs inside
 * the atomic room update, on the latest stored state: concurrent votes never
 * lose each other, a spectator's last vote always wins, and a vote racing the
 * end of the song is decided against the same state that finishes it.
 */
export class CastVote {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(input: CastVoteInput): Promise<CastVoteOutput> {
    const now = this.clock();
    let changed = false;
    const room = await updateRoom(this.rooms, input.roomCode, (current) => {
      // Assigned on every run: `mutate` runs again after a version conflict.
      const next = RoomService.castVote(current, input.voterId, input.dancerId, now);
      changed = next !== current;
      return next;
    });
    return { room, dancerId: RoomService.voteOf(room, input.voterId), changed };
  }
}
