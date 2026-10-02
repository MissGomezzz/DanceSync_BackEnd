import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { SongSelectionService, type RandomIndex } from "../../domain/services/SongSelectionService.js";

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
    const room = await this.requireRoom(input.roomCode);
    if (room.hostId !== input.requesterId) {
      throw new DomainError("INVALID_RATER", "Only the host can start the song selection");
    }
    const updated = SongSelectionService.start(room, this.options);
    await this.rooms.save(updated);
    return updated;
  }

  /** Resolves a challenge whose countdown ran out. Returns null when there was nothing to expire. */
  async expire(input: ExpireSongChallengeInput): Promise<Room | null> {
    const room = await this.rooms.findByCode(input.roomCode);
    if (!room) return null;
    const updated = SongSelectionService.expire(room, input.challengeId, this.options.random);
    if (!updated) return null;
    await this.rooms.save(updated);
    return updated;
  }

  private async requireRoom(code: string): Promise<Room> {
    const room = await this.rooms.findByCode(code);
    if (!room) throw new DomainError("ROOM_NOT_FOUND", `Room ${code} does not exist`);
    return room;
  }
}
