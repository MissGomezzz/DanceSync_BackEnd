import { randomInt, randomUUID } from "node:crypto";
import { SONG_CHALLENGE_PHRASES } from "../catalog/phrases.js";
import { SONG_CATALOG } from "../catalog/songs.js";
import { DomainError } from "../errors/DomainError.js";
import { MIN_DANCERS_PER_BATTLE, type Room } from "../model/Room.js";
import type { Song } from "../model/Song.js";
import {
  DEFAULT_SONG_CHALLENGE_MS,
  DEFAULT_SONG_CHOOSE_MS,
  type ChooserReason,
  type SongSelection,
} from "../model/SongSelection.js";
import { requireEveryoneReady } from "./readiness.js";

/** Returns an integer in [0, length). Injected so tests can make picks deterministic. */
export type RandomIndex = (length: number) => number;

export const secureRandomIndex: RandomIndex = (length) => randomInt(length);

export type SubmitOutcome = "accepted" | "incorrect" | "expired";

export interface StartChallengeOptions {
  now?: Date;
  durationMs?: number;
  /** Time each chooser gets to pick a song (see SongSelection.chooseDeadline). */
  chooseMs?: number;
  random?: RandomIndex;
  phrases?: readonly string[];
  songs?: readonly Song[];
}

/** Ignores surrounding whitespace and Unicode composition differences, nothing else. */
export function normalizeAttempt(text: string): string {
  return text.normalize("NFC").trim();
}

export function isSelectionInProgress(room: Room): boolean {
  const phase = room.songSelection?.phase;
  return phase === "typing" || phase === "choosing";
}

export const SongSelectionService = {
  /**
   * Shows a random phrase to every dancer in the lobby and starts the countdown.
   * This is the first step of starting a battle, so every player must be ready.
   */
  start(room: Room, options: StartChallengeOptions = {}): Room {
    const {
      now = new Date(),
      durationMs = DEFAULT_SONG_CHALLENGE_MS,
      chooseMs = DEFAULT_SONG_CHOOSE_MS,
      random = secureRandomIndex,
      phrases = SONG_CHALLENGE_PHRASES,
      songs = SONG_CATALOG,
    } = options;

    if (!Number.isFinite(chooseMs) || chooseMs <= 0) {
      throw new RangeError(`The time to choose a song must be more than 0 ms, received ${chooseMs}`);
    }
    if (room.status !== "waiting") {
      throw new DomainError("ROOM_NOT_WAITING", `Room ${room.code} is not in the lobby`);
    }
    if (isSelectionInProgress(room)) {
      throw new DomainError("SONG_SELECTION_IN_PROGRESS", "A song selection is already in progress");
    }
    const participantIds = room.players.filter((p) => p.role === "dancer").map((p) => p.id);
    if (participantIds.length < MIN_DANCERS_PER_BATTLE) {
      throw new DomainError(
        "NOT_ENOUGH_DANCERS",
        `At least ${MIN_DANCERS_PER_BATTLE} dancers are required to pick a song`,
      );
    }

    requireEveryoneReady(room);

    // Avoid showing the same phrase twice in a row when there is a choice.
    const previous = room.songSelection?.challenge.phrase;
    const pool = phrases.length > 1 ? phrases.filter((p) => p !== previous) : phrases;
    const phrase = pool[random(pool.length)];

    const songSelection: SongSelection = {
      phase: "typing",
      challenge: {
        id: randomUUID(),
        phrase,
        startedAt: now,
        expiresAt: new Date(now.getTime() + durationMs),
      },
      participantIds,
      failedIds: [],
      chooserId: null,
      chooserReason: null,
      songOptions: [...songs],
      chooseMs,
      chooseDeadline: null,
      autoPicked: false,
    };
    return { ...room, songSelection, selectedSong: null };
  },

  /**
   * Validates a typed attempt. The first exact match wins the right to choose the
   * song; a misspelling costs that player the chance for this round; a late
   * submission resolves the round as timed out.
   */
  submit(
    room: Room,
    playerId: string,
    text: string,
    now: Date = new Date(),
    random: RandomIndex = secureRandomIndex,
  ): { room: Room; outcome: SubmitOutcome } {
    const selection = requireTyping(room);
    if (!selection.participantIds.includes(playerId)) {
      throw new DomainError("NOT_CHALLENGE_PARTICIPANT", "Only dancers in this challenge can type the phrase");
    }
    // Participants are snapshotted at the start; one who left since cannot play.
    if (!isPresent(room, playerId)) {
      throw new DomainError("PLAYER_NOT_IN_ROOM", `Player ${playerId} is not in room ${room.code}`);
    }
    // Expiry is checked before the used-attempt rule: once the countdown is over
    // every late submission resolves the round as timed out, including one from a
    // dancer who already misspelled (they would otherwise get a misleading error
    // and the round would wait for the server timer).
    if (now.getTime() >= selection.challenge.expiresAt.getTime()) {
      return { room: assignFallbackChooser(room, selection, "timeout", random, now), outcome: "expired" };
    }
    if (selection.failedIds.includes(playerId)) {
      throw new DomainError("ATTEMPT_ALREADY_USED", "You already used your attempt in this challenge");
    }

    if (normalizeAttempt(text) === selection.challenge.phrase) {
      return {
        room: { ...room, songSelection: choosing(selection, playerId, "typed", now) },
        outcome: "accepted",
      };
    }

    const failed: SongSelection = { ...selection, failedIds: [...selection.failedIds, playerId] };
    // Only participants still in the room count: one who left can no longer type,
    // so waiting for them would hold the round until the countdown runs out.
    const everyoneFailed = failed.participantIds
      .filter((id) => isPresent(room, id))
      .every((id) => failed.failedIds.includes(id));
    return {
      room: everyoneFailed
        ? assignFallbackChooser(room, failed, "all-failed", random, now)
        : { ...room, songSelection: failed },
      outcome: "incorrect",
    };
  },

  /**
   * Called when the countdown reaches zero. Returns null when there is nothing to
   * expire (the round was already won, replaced by a new one, or cancelled).
   */
  expire(
    room: Room,
    challengeId: string,
    random: RandomIndex = secureRandomIndex,
    now: Date = new Date(),
  ): Room | null {
    const selection = room.songSelection;
    if (!selection || selection.phase !== "typing" || selection.challenge.id !== challengeId) return null;
    return assignFallbackChooser(room, selection, "timeout", random, now);
  },

  choose(room: Room, playerId: string, songId: string): Room {
    const selection = room.songSelection;
    if (!selection || selection.phase !== "choosing") {
      throw new DomainError("SONG_SELECTION_NOT_ACTIVE", "Nobody is choosing a song right now");
    }
    if (selection.chooserId !== playerId) {
      throw new DomainError("NOT_SONG_CHOOSER", "Only the player who won the challenge can choose the song");
    }
    const song = selection.songOptions.find((s) => s.id === songId);
    if (!song) {
      throw new DomainError("INVALID_SONG", `Song ${songId} is not one of the options`);
    }
    return { ...room, songSelection: { ...selection, phase: "done", chooseDeadline: null }, selectedSong: song };
  },

  /**
   * Called when the chooser's deadline passes: picks a random song among the
   * options for them, exactly as if they had chosen it (the caller then follows
   * the manual choice path, which may start the battle). Returns null when there
   * is nothing to pick: another challenge, not choosing anymore (the chooser
   * already picked or the selection was cancelled) or the deadline not reached
   * yet (the turn passed to someone else and was renewed).
   */
  autoPick(room: Room, challengeId: string, now: Date = new Date(), random: RandomIndex = secureRandomIndex): Room | null {
    const selection = room.songSelection;
    if (!selection || selection.phase !== "choosing" || selection.challenge.id !== challengeId) return null;
    if (!selection.chooserId || !selection.chooseDeadline || now.getTime() < selection.chooseDeadline.getTime()) {
      return null;
    }
    if (selection.songOptions.length === 0) {
      // Nothing to pick from: cancel so the host can start a new selection.
      return { ...room, songSelection: null };
    }
    const song = selection.songOptions[random(selection.songOptions.length)];
    const chosen = SongSelectionService.choose(room, selection.chooserId, song.id);
    return { ...chosen, songSelection: { ...chosen.songSelection!, autoPicked: true } };
  },

  /**
   * Passes the choice to someone else when the chooser leaves before picking.
   * `room` must already have the player removed.
   */
  handlePlayerLeft(
    room: Room,
    playerId: string,
    random: RandomIndex = secureRandomIndex,
    now: Date = new Date(),
  ): Room {
    const selection = room.songSelection;
    if (!selection || selection.phase !== "choosing" || selection.chooserId !== playerId) return room;
    return assignFallbackChooser(room, selection, "chooser-left", random, now);
  },
};

function isPresent(room: Room, playerId: string): boolean {
  return room.players.some((p) => p.id === playerId);
}

function requireTyping(room: Room): SongSelection {
  const selection = room.songSelection;
  if (!selection || selection.phase !== "typing") {
    throw new DomainError("SONG_SELECTION_NOT_ACTIVE", "There is no phrase to type right now");
  }
  return selection;
}

/**
 * Predefined fallback: the turn passes to a random participant who is still in
 * the room and did not misspell the phrase; if every one of them failed, any
 * remaining participant can be picked. With no participants left the selection
 * is cancelled so the host can start a new one.
 */
function assignFallbackChooser(
  room: Room,
  selection: SongSelection,
  reason: ChooserReason,
  random: RandomIndex,
  now: Date,
): Room {
  const present = selection.participantIds.filter((id) => isPresent(room, id));
  const notFailed = present.filter((id) => !selection.failedIds.includes(id));
  const candidates = notFailed.length > 0 ? notFailed : present;
  if (candidates.length === 0) {
    return { ...room, songSelection: null };
  }
  const chooserId = candidates[random(candidates.length)];
  return { ...room, songSelection: choosing(selection, chooserId, reason, now) };
}

/** Hands the choice to `chooserId` with a fresh deadline (every chooser gets the full time). */
function choosing(selection: SongSelection, chooserId: string, reason: ChooserReason, now: Date): SongSelection {
  return {
    ...selection,
    phase: "choosing",
    chooserId,
    chooserReason: reason,
    chooseDeadline: new Date(now.getTime() + selection.chooseMs),
  };
}
