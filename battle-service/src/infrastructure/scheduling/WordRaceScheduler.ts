import type { ExpireWordRound } from "../../application/usecases/ExpireWordRound.js";
import type { OpenWordRound } from "../../application/usecases/OpenWordRound.js";
import type { StartWordRace } from "../../application/usecases/StartWordRace.js";
import type { StopWordRace } from "../../application/usecases/StopWordRace.js";
import type { WordRace, WordRound } from "../../domain/model/WordRace.js";

/** Outbound port used to tell the room that a round started or ended. */
export interface WordRaceBroadcaster {
  roundStarted(race: WordRace, round: WordRound, now: Date): void;
  /** Called exactly once per round: by the winner's claim or by the expiry, never both. */
  roundEnded(race: WordRace, round: WordRound): void;
}

export interface WordRaceSchedulerDependencies {
  startWordRace: StartWordRace;
  openWordRound: OpenWordRound;
  expireWordRound: ExpireWordRound;
  stopWordRace: StopWordRace;
  broadcaster: WordRaceBroadcaster;
  clock?: () => Date;
}

/**
 * Owns every timer of the word race: one per round opening and one per round
 * expiry. Timers only trigger use cases; whether a round actually opens or
 * expires is decided atomically by the repository, so a late or duplicated timer
 * is harmless.
 */
export class WordRaceScheduler {
  private readonly deps: WordRaceSchedulerDependencies;
  private readonly clock: () => Date;
  private readonly timers = new Map<string, Set<NodeJS.Timeout>>();

  constructor(deps: WordRaceSchedulerDependencies) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Plans the race of a battle that just started and schedules every round opening. */
  async start(roomCode: string): Promise<WordRace> {
    this.clearTimers(roomCode);
    const race = await this.deps.startWordRace.execute({ roomCode });
    this.timers.set(race.roomCode.toUpperCase(), new Set());
    for (const round of race.rounds) {
      this.schedule(race.roomCode, round.opensAt, () => this.open(race.roomCode, round.id));
    }
    return race;
  }

  /** Cancels pending rounds and discards the race (battle finished or room gone). */
  async stop(roomCode: string): Promise<void> {
    this.clearTimers(roomCode);
    await this.deps.stopWordRace.execute({ roomCode });
  }

  /** Pending timers, for one room or overall. Used by tests to prove nothing leaks. */
  pendingTimers(roomCode?: string): number {
    if (roomCode !== undefined) return this.timers.get(roomCode.toUpperCase())?.size ?? 0;
    let total = 0;
    for (const set of this.timers.values()) total += set.size;
    return total;
  }

  private async open(roomCode: string, roundId: string): Promise<void> {
    const result = await this.deps.openWordRound.execute({ roomCode, roundId });
    if (!result.opened) {
      if (result.reason === "battle-over") await this.stop(roomCode);
      return;
    }
    this.deps.broadcaster.roundStarted(result.race, result.round, this.clock());
    this.schedule(roomCode, result.round.closesAt, () => this.expire(roomCode, roundId));
  }

  private async expire(roomCode: string, roundId: string): Promise<void> {
    const result = await this.deps.expireWordRound.execute({ roomCode, roundId });
    if (result.expired) {
      this.deps.broadcaster.roundEnded(result.race, result.round);
    } else if (result.round?.status === "open") {
      // The timer fired a moment before closesAt (timer and wall clock differ by a
      // few ms); try again for the remaining time.
      this.schedule(roomCode, result.round.closesAt, () => this.expire(roomCode, roundId));
    }
    // Otherwise someone won the round and their claim already announced it.
  }

  private schedule(roomCode: string, at: Date, task: () => Promise<void>): void {
    const set = this.timers.get(roomCode.toUpperCase());
    if (!set) return; // Stopped meanwhile.
    const delay = Math.max(0, at.getTime() - this.clock().getTime());
    const timer = setTimeout(() => {
      set.delete(timer);
      task().catch((error: unknown) => console.error("Word race timer failed", error));
    }, delay);
    set.add(timer);
  }

  private clearTimers(roomCode: string): void {
    const key = roomCode.toUpperCase();
    const set = this.timers.get(key);
    if (set) for (const timer of set) clearTimeout(timer);
    this.timers.delete(key);
  }
}
