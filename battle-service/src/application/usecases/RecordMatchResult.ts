import { setTimeout as delay } from "node:timers/promises";
import type { MatchRecord } from "../../domain/model/MatchRecord.js";
import type { Room } from "../../domain/model/Room.js";
import type { MatchOutbox, PendingMatch } from "../../domain/ports/MatchOutbox.js";
import { MatchPublishError, type MatchResultPublisher } from "../../domain/ports/MatchResultPublisher.js";
import { MatchRecordService } from "../../domain/services/MatchRecordService.js";

export interface RecordMatchResultOptions {
  /** Total immediate tries by the finishing replica, the first included. Default 3. */
  attempts?: number;
  /** Wait before the second try; doubled before each further one. Default 500 ms. */
  baseDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** `warn` (a match kept for redelivery) falls back to `error` when absent. */
  logger?: MatchLogger;
  /**
   * Durable outbox (DIS-1). With it, a match is stored before it is sent and
   * stays there until a delivery succeeds, whichever replica makes it (see
   * drain). Without it (harnesses), a match whose immediate tries all fail is
   * only logged.
   */
  outbox?: MatchOutbox;
  clock?: () => Date;
  /**
   * Backoff of the deliveries retried from the outbox: the first retry waits
   * this long (it also keeps the sweep away from a match its finisher is still
   * trying), doubled after each failure up to redeliveryMaxMs. Defaults 5 s and 5 min.
   */
  redeliveryBaseMs?: number;
  redeliveryMaxMs?: number;
  /** Matches delivered per drain. Default 50. */
  drainBatch?: number;
}

export type MatchLogger = Pick<Console, "info" | "error"> & Partial<Pick<Console, "warn">>;

export interface DrainResult {
  delivered: number;
  failed: number;
}

/**
 * Stores a finished battle in the match history (HU 21) through the
 * MatchResultPublisher port. It never throws and the caller never waits for
 * it: the live room already carries the result, so an unavailable history
 * store must not affect the battle.
 *
 * DIS-1, no result lost: the match is first put in the durable outbox, then
 * sent at once with exponential backoff; it leaves the outbox only after a
 * successful delivery. Whatever is still pending (users-service down, or the
 * finishing replica died) is delivered by `drain`, run by every replica's
 * sweep. `enqueueFinished` closes the last gap: a replica that died between
 * finishing the battle and enqueuing it. Duplicate deliveries are harmless (the
 * history upserts by battle id).
 */
export class RecordMatchResult {
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Required<MatchLogger>;
  private readonly outbox: MatchOutbox | undefined;
  private readonly clock: () => Date;
  private readonly redeliveryBaseMs: number;
  private readonly redeliveryMaxMs: number;
  private readonly drainBatch: number;

  constructor(
    private readonly publisher: MatchResultPublisher,
    options: RecordMatchResultOptions = {},
  ) {
    this.attempts = Math.max(1, options.attempts ?? 3);
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.sleep = options.sleep ?? ((ms) => delay(ms).then(() => undefined));
    const logger = options.logger ?? console;
    this.logger = { info: logger.info, error: logger.error, warn: logger.warn ?? logger.error };
    this.outbox = options.outbox;
    this.clock = options.clock ?? (() => new Date());
    this.redeliveryBaseMs = options.redeliveryBaseMs ?? 5_000;
    this.redeliveryMaxMs = options.redeliveryMaxMs ?? 300_000;
    this.drainBatch = options.drainBatch ?? 50;
  }

  /**
   * Called once per battle by the replica whose update finished it. Returns
   * true once the match is stored in the history; false when there was nothing
   * to store or every immediate try failed (it is then kept in the outbox).
   */
  async execute(room: Room): Promise<boolean> {
    const match = MatchRecordService.fromFinishedRoom(room);
    if (!match) return false;
    const durable = await this.enqueue(match, new Date(this.clock().getTime() + this.redeliveryBaseMs));
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        await this.publisher.publish(match);
        this.logger.info(`Match ${match.id} of room ${match.roomCode} stored in the match history`);
        await this.ack(match.id);
        return true;
      } catch (error) {
        lastError = error;
        if (error instanceof MatchPublishError && !error.retryable) break;
        if (attempt < this.attempts) await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
    if (durable) {
      this.logger.warn(`Match ${match.id} of room ${match.roomCode} not stored yet; kept in the outbox for redelivery`, lastError);
    } else {
      this.logger.error(`Match ${match.id} of room ${match.roomCode} could not be stored in the match history`, lastError);
    }
    return false;
  }

  /**
   * Safety net of the sweep: puts the result of a finished room in the outbox
   * unless it is pending or was delivered already. Returns true when it was
   * missing (the replica that finished the battle died before enqueuing it).
   */
  async enqueueFinished(room: Room): Promise<boolean> {
    if (!this.outbox) return false;
    const match = MatchRecordService.fromFinishedRoom(room);
    if (!match) return false;
    try {
      const added = await this.outbox.enqueue(match, this.clock());
      if (added) this.logger.warn(`Match ${match.id} of room ${match.roomCode} was missing from the outbox; enqueued by the sweep`);
      return added;
    } catch (error) {
      this.logger.error(`Could not put match ${match.id} in the outbox`, error);
      return false;
    }
  }

  /**
   * Delivers every pending match that is due, one try each; a failure is
   * rescheduled with exponential backoff (a document refused for good waits
   * the maximum backoff and stays visible in the logs). Never throws.
   */
  async drain(): Promise<DrainResult> {
    const result: DrainResult = { delivered: 0, failed: 0 };
    if (!this.outbox) return result;
    let due: PendingMatch[];
    try {
      due = await this.outbox.listPending(this.clock(), this.drainBatch);
    } catch (error) {
      this.logger.error("Could not read the match outbox", error);
      return result;
    }
    for (const pending of due) {
      try {
        await this.publisher.publish(pending.match);
        await this.outbox.ack(pending.match.id);
        this.logger.info(`Match ${pending.match.id} of room ${pending.match.roomCode} delivered from the outbox`);
        result.delivered += 1;
      } catch (error) {
        result.failed += 1;
        await this.reschedule(pending, error);
      }
    }
    return result;
  }

  private async reschedule(pending: PendingMatch, error: unknown): Promise<void> {
    const attempts = pending.attempts + 1;
    const permanent = error instanceof MatchPublishError && !error.retryable;
    const waitMs = permanent
      ? this.redeliveryMaxMs
      : Math.min(this.redeliveryMaxMs, this.redeliveryBaseMs * 2 ** (attempts - 1));
    const log = permanent ? this.logger.error : this.logger.warn;
    log.call(this.logger, `Match ${pending.match.id} delivery ${attempts} from the outbox failed; next try in ${waitMs} ms`, error);
    try {
      await this.outbox!.retryLater({ ...pending, attempts, nextAttemptAt: new Date(this.clock().getTime() + waitMs) });
    } catch (storeError) {
      // It stays due: the next drain tries it again.
      this.logger.error(`Could not reschedule match ${pending.match.id} in the outbox`, storeError);
    }
  }

  /** True when the match is in the outbox (added now or already there). A store failure is logged: the immediate tries still run. */
  private async enqueue(match: MatchRecord, notBefore: Date): Promise<boolean> {
    if (!this.outbox) return false;
    try {
      await this.outbox.enqueue(match, notBefore);
      return true;
    } catch (error) {
      this.logger.error(`Could not put match ${match.id} in the outbox`, error);
      return false;
    }
  }

  private async ack(matchId: string): Promise<void> {
    if (!this.outbox) return;
    try {
      await this.outbox.ack(matchId);
    } catch (error) {
      // Delivered, but still pending: a later drain sends it again, which the upsert absorbs.
      this.logger.error(`Could not remove match ${matchId} from the outbox`, error);
    }
  }
}
