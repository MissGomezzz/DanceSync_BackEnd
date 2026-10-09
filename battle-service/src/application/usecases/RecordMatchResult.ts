import { setTimeout as delay } from "node:timers/promises";
import type { Room } from "../../domain/model/Room.js";
import { MatchPublishError, type MatchResultPublisher } from "../../domain/ports/MatchResultPublisher.js";
import { MatchRecordService } from "../../domain/services/MatchRecordService.js";

export interface RecordMatchResultOptions {
  /** Total tries, the first included. Default 3. */
  attempts?: number;
  /** Wait before the second try; doubled before each further one. Default 500 ms. */
  baseDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, "info" | "error">;
}

/**
 * Stores a finished battle in the match history (HU 21) through the
 * MatchResultPublisher port, retrying with exponential backoff. It never throws
 * and the caller never waits for it: the live room already carries the result,
 * so an unavailable history store must not affect the battle. A failure that
 * outlives the retries is logged.
 */
export class RecordMatchResult {
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<Console, "info" | "error">;

  constructor(
    private readonly publisher: MatchResultPublisher,
    options: RecordMatchResultOptions = {},
  ) {
    this.attempts = Math.max(1, options.attempts ?? 3);
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.sleep = options.sleep ?? ((ms) => delay(ms).then(() => undefined));
    this.logger = options.logger ?? console;
  }

  /** Returns true once the match is stored; false when there was nothing to store or every try failed. */
  async execute(room: Room): Promise<boolean> {
    const match = MatchRecordService.fromFinishedRoom(room);
    if (!match) return false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        await this.publisher.publish(match);
        this.logger.info(`Match ${match.id} of room ${match.roomCode} stored in the match history`);
        return true;
      } catch (error) {
        lastError = error;
        if (error instanceof MatchPublishError && !error.retryable) break;
        if (attempt < this.attempts) await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
    this.logger.error(`Match ${match.id} of room ${match.roomCode} could not be stored in the match history`, lastError);
    return false;
  }
}
