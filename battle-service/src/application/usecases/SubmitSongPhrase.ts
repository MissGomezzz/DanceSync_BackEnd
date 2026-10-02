import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import {
  SongSelectionService,
  type RandomIndex,
  type SubmitOutcome,
} from "../../domain/services/SongSelectionService.js";

export interface SubmitSongPhraseInput {
  roomCode: string;
  playerId: string;
  text: string;
}

export interface SubmitSongPhraseOutput {
  room: Room;
  outcome: SubmitOutcome;
}

export class SubmitSongPhrase {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly random?: RandomIndex,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(input: SubmitSongPhraseInput): Promise<SubmitSongPhraseOutput> {
    const room = await this.rooms.findByCode(input.roomCode);
    if (!room) throw new DomainError("ROOM_NOT_FOUND", `Room ${input.roomCode} does not exist`);
    if (typeof input.text !== "string") {
      throw new DomainError("INVALID_MESSAGE", "The typed phrase must be text");
    }
    const result = SongSelectionService.submit(room, input.playerId, input.text, this.clock(), this.random);
    await this.rooms.save(result.room);
    return result;
  }
}
