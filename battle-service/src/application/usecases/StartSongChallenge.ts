import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { SongSelectionService, type RandomIndex } from "../../domain/services/SongSelectionService.js";
import { updateRoom } from "../roomUpdates.js";

export interface StartSongChallengeInput {
  roomCode: string;
  /** Player requesting the challenge; must be the room host. */
  requesterId: string;
}

export interface ExpireSongChallengeInput {
  roomCode: string;
  challengeId: string;
}

export interface SongChallengeOptions {
  durationMs?: number;
  random?: RandomIndex;
  phrases?: readonly string[];
}

export class StartSongChallenge {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly options: SongChallengeOptions = {},
  ) {}

  async execute(input: StartSongChallengeInput): Promise<Room> {
    return updateRoom(this.rooms, input.roomCode, (room) => {
      if (room.hostId !== input.requesterId) {
        throw new DomainError("NOT_HOST", "Only the host can start the song selection");
      }
      return SongSelectionService.start(room, this.options);
    });
  }

  /** Resolves a challenge whose countdown ran out. Returns null when there was nothing to expire. */
  async expire(input: ExpireSongChallengeInput): Promise<Room | null> {
    let expired = false;
    try {
      const room = await updateRoom(this.rooms, input.roomCode, (current) => {
        const updated = SongSelectionService.expire(current, input.challengeId, this.options.random);
        expired = updated !== null;
        return updated ?? current;
      });
      return expired ? room : null;
    } catch (error) {
      if (error instanceof DomainError && error.code === "ROOM_NOT_FOUND") return null;
      throw error;
    }
  }
}
