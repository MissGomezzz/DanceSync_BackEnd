import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";
import { SongSelectionService } from "../../domain/services/SongSelectionService.js";
import { updateRoom } from "../roomUpdates.js";

export interface ChooseSongInput {
  roomCode: string;
  playerId: string;
  songId: string;
}

export interface ChooseSongOutput {
  room: Room;
  /**
   * True when choosing the song also started the battle. False when the battle
   * could not start yet (a dancer left, someone cancelled being ready): the song
   * stays chosen and the host starts the battle once the room is startable again.
   */
  battleStarted: boolean;
}

/** The last step of the lobby flow: the chosen song starts the battle in the same stored change. */
export class ChooseSong {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: ChooseSongInput): Promise<ChooseSongOutput> {
    let battleStarted = false;
    const room = await updateRoom(this.rooms, input.roomCode, (current) => {
      // `mutate` can run again after a version conflict: start from a clean flag.
      battleStarted = false;
      const chosen = SongSelectionService.choose(current, input.playerId, input.songId);
      try {
        const started = RoomService.startBattle(chosen);
        battleStarted = true;
        return started;
      } catch (error) {
        if (error instanceof DomainError) return chosen;
        throw error;
      }
    });
    return { room, battleStarted };
  }
}
