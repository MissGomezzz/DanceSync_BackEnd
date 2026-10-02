import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import {
  SongSelectionService,
  type RandomIndex,
  type SubmitOutcome,
} from "../../domain/services/SongSelectionService.js";
import { updateRoom } from "../roomUpdates.js";

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
    if (typeof input.text !== "string") {
      throw new DomainError("INVALID_MESSAGE", "The typed phrase must be text");
    }
    const now = this.clock();
    let outcome: SubmitOutcome = "incorrect";
    // The winner is decided on the latest stored state: of several simultaneous
    // correct submissions only the first update still sees phase "typing"; the
    // others run on "choosing" and are rejected with SONG_SELECTION_NOT_ACTIVE.
    const room = await updateRoom(this.rooms, input.roomCode, (current) => {
      const result = SongSelectionService.submit(current, input.playerId, input.text, now, this.random);
      outcome = result.outcome;
      return result.room;
    });
    return { room, outcome };
  }
}
