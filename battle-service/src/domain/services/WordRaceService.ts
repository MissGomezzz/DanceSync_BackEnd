import { WORD_RACE_WORDS } from "../catalog/words.js";
import { DomainError } from "../errors/DomainError.js";
import type { Room } from "../model/Room.js";
import {
  DEFAULT_WORD_END_MARGIN_RATIO,
  DEFAULT_WORD_FALLBACK_DURATION_MS,
  DEFAULT_WORD_MIN_GAP_MS,
  DEFAULT_WORD_RACE_ROUNDS,
  DEFAULT_WORD_START_MARGIN_RATIO,
  DEFAULT_WORD_WINDOW_MS,
  type WordRace,
  type WordRound,
} from "../model/WordRace.js";
import { normalizeAttempt, secureRandomIndex, type RandomIndex } from "./SongSelectionService.js";

export interface PlanWordRaceOptions {
  /** Rounds wanted; fewer are planned when the song is too short to fit them. */
  rounds?: number;
  windowMs?: number;
  minGapMs?: number;
  /** Song length used when the battle has no song. */
  fallbackDurationMs?: number;
  /** Rounds open and close inside [startMarginRatio, endMarginRatio] of the song. */
  startMarginRatio?: number;
  endMarginRatio?: number;
  random?: RandomIndex;
  words?: readonly string[];
  /**
   * Test override: explicit opening offsets in ms after battle.startedAt. Skips the
   * random timeline (one round per offset, in ascending order).
   */
  offsetsMs?: readonly number[];
}

/** Pure validation verdict. "correct" still has to win the atomic claim to become "won". */
export type WordJudgement = "correct" | "incorrect" | "expired";

export const WordRaceService = {
  /**
   * Plans the rounds of a battle that just started: distinct random words at
   * random moments of the song, never overlapping.
   */
  plan(room: Room, options: PlanWordRaceOptions = {}): WordRace {
    const {
      rounds = DEFAULT_WORD_RACE_ROUNDS,
      windowMs = DEFAULT_WORD_WINDOW_MS,
      minGapMs = DEFAULT_WORD_MIN_GAP_MS,
      fallbackDurationMs = DEFAULT_WORD_FALLBACK_DURATION_MS,
      startMarginRatio = DEFAULT_WORD_START_MARGIN_RATIO,
      endMarginRatio = DEFAULT_WORD_END_MARGIN_RATIO,
      random = secureRandomIndex,
      words = WORD_RACE_WORDS,
      offsetsMs,
    } = options;

    const battle = room.battle;
    if (room.status !== "battling" || !battle) {
      throw new DomainError("ROOM_NOT_BATTLING", `Room ${room.code} has no battle in progress`);
    }

    const songMs = battle.song ? battle.song.durationSeconds * 1000 : fallbackDurationMs;
    const planned = offsetsMs
      ? [...offsetsMs].sort((a, b) => a - b)
      : randomOffsets(songMs, rounds, windowMs, minGapMs, startMarginRatio, endMarginRatio, random);
    const picked = pickDistinct(words, planned.length, random);
    const startedAt = battle.startedAt.getTime();

    const wordRounds: WordRound[] = picked.map((word, i) => ({
      id: `${battle.id}:${i + 1}`,
      number: i + 1,
      word,
      opensAt: new Date(startedAt + planned[i]),
      closesAt: new Date(startedAt + planned[i] + windowMs),
      winnerId: null,
      status: "scheduled",
    }));

    const participantIds = [...battle.dancerIds];
    const participantNames: Record<string, string> = {};
    const wins: Record<string, number> = {};
    for (const id of participantIds) {
      participantNames[id] = room.players.find((p) => p.id === id)?.displayName ?? id;
      wins[id] = 0;
    }

    return { roomCode: room.code, battleId: battle.id, participantIds, participantNames, rounds: wordRounds, wins };
  },

  /**
   * Validates a typed attempt without deciding anything: a "correct" verdict only
   * means the text matches. Who wins is decided by the repository's atomic claim,
   * so a correct attempt on a round someone already won comes back as "late".
   * Wrong attempts do not lock the dancer out: typos while dancing are expected.
   */
  judge(round: WordRound, participantIds: readonly string[], playerId: string, text: string, now: Date): WordJudgement {
    if (!participantIds.includes(playerId)) {
      throw new DomainError("NOT_CHALLENGE_PARTICIPANT", "Only the dancers in this battle can type the word");
    }
    if (round.status === "scheduled") {
      throw new DomainError("WORD_ROUND_NOT_OPEN", `Round ${round.number} is not open yet`);
    }
    if (round.status === "expired" || now.getTime() >= round.closesAt.getTime()) {
      return "expired";
    }
    return normalizeAttempt(text).toLowerCase() === round.word ? "correct" : "incorrect";
  },
};

/**
 * Spreads `rounds` openings over the usable part of the song. Each round needs
 * `windowMs` and consecutive openings are at least max(minGapMs, windowMs) apart,
 * so windows never overlap. When the song is too short the number of rounds is
 * reduced instead.
 */
function randomOffsets(
  songMs: number,
  rounds: number,
  windowMs: number,
  minGapMs: number,
  startMarginRatio: number,
  endMarginRatio: number,
  random: RandomIndex,
): number[] {
  const first = Math.ceil(songMs * startMarginRatio);
  const lastOpen = Math.floor(songMs * endMarginRatio) - windowMs;
  const step = Math.max(minGapMs, windowMs);
  if (rounds <= 0 || lastOpen < first) return [];

  const span = lastOpen - first;
  const count = Math.min(rounds, Math.floor(span / step) + 1);
  // Draw `count` points in the slack left after reserving the gaps, sort them and
  // add the gaps back: random placement with every gap guaranteed.
  const slack = span - (count - 1) * step;
  const points = Array.from({ length: count }, () => random(slack + 1)).sort((a, b) => a - b);
  return points.map((point, i) => first + point + i * step);
}

/** Partial Fisher-Yates shuffle: `count` distinct entries (fewer if the pool is smaller). */
function pickDistinct(pool: readonly string[], count: number, random: RandomIndex): string[] {
  const remaining = [...pool];
  const picked: string[] = [];
  while (picked.length < count && remaining.length > 0) {
    const [word] = remaining.splice(random(remaining.length), 1);
    picked.push(word);
  }
  return picked;
}
