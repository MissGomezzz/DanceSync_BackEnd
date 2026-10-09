import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { RoomService } from "../../domain/services/RoomService.js";
import { secureRandomIndex, SongSelectionService, type RandomIndex } from "../../domain/services/SongSelectionService.js";
import { updateRoom } from "../roomUpdates.js";
import type { BattleTimingOptions } from "./StartBattle.js";

export interface ChooseSongInput {
  roomCode: string;
  playerId: string;
  songId: string;
}

export interface AutoPickSongInput {
  roomCode: string;
  /** The challenge whose chooser let the deadline pass. */
  challengeId: string;
}

export interface AutoPickSongOutput extends ChooseSongOutput {
  /** False when there was nothing to pick (see SongSelectionService.autoPick); `room` is then the stored state. */
  picked: boolean;
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
  constructor(
    private readonly rooms: RoomRepository,
    private readonly timing: BattleTimingOptions = {},
    private readonly random: RandomIndex = secureRandomIndex,
  ) {}

  /**
   * The chooser picks a song. A choice arriving after the deadline but before
   * the server's automatic pick is still accepted: it is the same outcome, with
   * the song the chooser actually wanted.
   */
  async execute(input: ChooseSongInput): Promise<ChooseSongOutput> {
    let battleStarted = false;
    const now = new Date();
    const room = await updateRoom(this.rooms, input.roomCode, (current) => {
      // `mutate` can run again after a version conflict: start from a clean flag.
      battleStarted = false;
      const chosen = SongSelectionService.choose(current, input.playerId, input.songId);
      const result = this.startIfPossible(chosen, now);
      battleStarted = result.battleStarted;
      return result.room;
    });
    return { room, battleStarted };
  }

  /**
   * The chooser's deadline passed: a random song is picked for them and the flow
   * continues exactly as after a manual choice (the battle starts when it can).
   * Harmless when the selection moved on meanwhile: nothing is written.
   */
  async autoPick(input: AutoPickSongInput): Promise<AutoPickSongOutput> {
    let picked = false;
    let battleStarted = false;
    const now = new Date();
    const room = await updateRoom(this.rooms, input.roomCode, (current) => {
      picked = false;
      battleStarted = false;
      const chosen = SongSelectionService.autoPick(current, input.challengeId, now, this.random);
      if (!chosen) return current;
      picked = true;
      const result = this.startIfPossible(chosen, now);
      battleStarted = result.battleStarted;
      return result.room;
    });
    return { room, picked, battleStarted };
  }

  /** The chosen song starts the battle in the same stored change, unless the room is not startable yet. */
  private startIfPossible(chosen: Room, now: Date): { room: Room; battleStarted: boolean } {
    if (chosen.songSelection === null) return { room: chosen, battleStarted: false };
    try {
      return { room: RoomService.startBattle(chosen, undefined, { ...this.timing, now }), battleStarted: true };
    } catch (error) {
      if (error instanceof DomainError) return { room: chosen, battleStarted: false };
      throw error;
    }
  }
}
