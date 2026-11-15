import type { LogFields, Logger } from "../../application/ports/Logger.js";
import type { ExpireWordRound } from "../../application/usecases/ExpireWordRound.js";
import type { OpenWordRound } from "../../application/usecases/OpenWordRound.js";
import type { ResumeWordRace } from "../../application/usecases/ResumeWordRace.js";
import type { StartWordRace } from "../../application/usecases/StartWordRace.js";
import type { StopWordRace } from "../../application/usecases/StopWordRace.js";
import type { WordRace, WordRound } from "../../domain/model/WordRace.js";
import { rootLogger } from "../logging/logger.js";

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
  /** Reads a stored race so this replica can take over its timers (DIS-1). */
  resumeWordRace: ResumeWordRace;
  broadcaster: WordRaceBroadcaster;
  clock?: () => Date;
  /**
   * Smallest wait before retrying an expiry that found the round still open.
   * The store decides with its own clock (Redis TIME), which can run a little
   * behind this one; without a floor the retry would spin. Default 50 ms.
   */
  retryDelayMs?: number;
  /** Structured logs (OBS-1). Default: the process logger. */
  logger?: Logger;
}

const DEFAULT_RETRY_DELAY_MS = 50;

/**
 * Owns the word race timers of this replica: one per round opening and one per
 * round expiry. Timers only trigger use cases; whether a round actually opens or
 * expires is decided atomically by the repository, and only the caller whose
 * transition was applied broadcasts it, so a late or duplicated timer (on this
 * replica or on another one) is harmless.
 *
 * DIS-1: any replica can take a race over with `resume`, from the absolute
 * round times stored with the race. The replica that started the battle is
 * therefore not a single point of failure for its word race.
 */
export class WordRaceScheduler {
  private readonly deps: WordRaceSchedulerDependencies;
  private readonly clock: () => Date;
  private readonly retryDelayMs: number;
  private readonly logger: Logger;
  /** Room (upper case) -> task ("open:<round>" / "expire:<round>") -> timer. One timer per task. */
  private readonly timers = new Map<string, Map<string, NodeJS.Timeout>>();

  constructor(deps: WordRaceSchedulerDependencies) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => new Date());
    this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.logger = deps.logger ?? rootLogger;
  }

  /** Plans the race of a battle that just started and schedules every round opening. */
  async start(roomCode: string): Promise<WordRace> {
    this.clearTimers(roomCode);
    const race = await this.deps.startWordRace.execute({ roomCode });
    this.logger.info({ ...raceFields(race), rounds: race.rounds.length }, "Word race planned");
    this.arm(race);
    return race;
  }

  /**
   * Takes over the race of a room whose battle is running, from the stored
   * state: an opening timer at opensAt for every scheduled round and an expiry
   * timer at closesAt for the open one. Idempotent on this replica (a task that
   * already has a timer is not armed twice). Returns the race, or null when the
   * room has no race of its running battle. Never clears timers: a battle that
   * is just starting may not have stored its race yet.
   */
  async resume(roomCode: string): Promise<WordRace | null> {
    const result = await this.deps.resumeWordRace.execute({ roomCode });
    if (!result.active) return null;
    this.arm(result.race);
    return result.race;
  }

  /** Cancels pending rounds and discards the race (battle finished or room gone). */
  async stop(roomCode: string): Promise<void> {
    this.clearTimers(roomCode);
    await this.deps.stopWordRace.execute({ roomCode });
  }

  /** Cancels every timer of this replica without touching the stored races (shutdown, tests). */
  close(): void {
    for (const roomCode of [...this.timers.keys()]) this.clearTimers(roomCode);
  }

  /** Pending timers, for one room or overall. Used by tests to prove nothing leaks. */
  pendingTimers(roomCode?: string): number {
    if (roomCode !== undefined) return this.timers.get(roomCode.toUpperCase())?.size ?? 0;
    let total = 0;
    for (const tasks of this.timers.values()) total += tasks.size;
    return total;
  }

  private arm(race: WordRace): void {
    const key = race.roomCode.toUpperCase();
    if (!this.timers.has(key)) this.timers.set(key, new Map());
    for (const round of race.rounds) {
      if (round.status === "scheduled") {
        this.schedule(race.roomCode, `open:${round.id}`, round.opensAt, () => this.open(race.roomCode, round.id));
      } else if (round.status === "open") {
        this.schedule(race.roomCode, `expire:${round.id}`, round.closesAt, () => this.expire(race.roomCode, round.id));
      }
    }
  }

  private async open(roomCode: string, roundId: string): Promise<void> {
    const result = await this.deps.openWordRound.execute({ roomCode, roundId });
    if (!result.opened) {
      if (result.reason === "battle-over") await this.stop(roomCode);
      return;
    }
    this.logger.info({ ...raceFields(result.race), roundId }, "Word round opened");
    this.deps.broadcaster.roundStarted(result.race, result.round, this.clock());
    this.schedule(roomCode, `expire:${roundId}`, result.round.closesAt, () => this.expire(roomCode, roundId));
  }

  private async expire(roomCode: string, roundId: string): Promise<void> {
    const result = await this.deps.expireWordRound.execute({ roomCode, roundId });
    if (result.expired) {
      this.logger.info({ ...raceFields(result.race), roundId, outcome: "expired" }, "Word round ended");
      this.deps.broadcaster.roundEnded(result.race, result.round);
    } else if (result.round?.status === "open") {
      // Fired before closesAt as the store sees it (timer drift, or the store's
      // clock runs behind this one): try again for the remaining time.
      this.schedule(roomCode, `expire:${roundId}`, result.round.closesAt, () => this.expire(roomCode, roundId), this.retryDelayMs);
    }
    // Otherwise someone won the round (their claim announced it) or another
    // replica expired it (and announced it).
  }

  private schedule(roomCode: string, task: string, at: Date, run: () => Promise<void>, minDelayMs = 0): void {
    const tasks = this.timers.get(roomCode.toUpperCase());
    if (!tasks) return; // Stopped meanwhile.
    if (tasks.has(task)) return; // Already armed on this replica.
    const delay = Math.max(minDelayMs, at.getTime() - this.clock().getTime());
    const timer = setTimeout(() => {
      tasks.delete(task);
      run().catch((error: unknown) => this.logger.error({ roomId: roomCode, task, err: error }, "Word race timer failed"));
    }, delay);
    // A pending round must never keep a stopping process alive.
    timer.unref();
    tasks.set(task, timer);
  }

  private clearTimers(roomCode: string): void {
    const key = roomCode.toUpperCase();
    const tasks = this.timers.get(key);
    if (tasks) for (const timer of tasks.values()) clearTimeout(timer);
    this.timers.delete(key);
  }
}

/** Room, battle and the battle's correlation id (OBS-1) of a race's log lines. */
function raceFields(race: WordRace): LogFields {
  return { roomId: race.roomCode, battleId: race.battleId, ...(race.correlationId ? { correlationId: race.correlationId } : {}) };
}
