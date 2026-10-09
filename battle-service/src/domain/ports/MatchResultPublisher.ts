import type { MatchRecord } from "../model/MatchRecord.js";

/**
 * Outbound port: stores the result of a finished battle in the match history
 * (users-service today). Implementations must be idempotent on `match.id`
 * (the battle id): publishing the same match twice stores it once.
 */
export interface MatchResultPublisher {
  /** Resolves once the match is stored; rejects otherwise (see MatchPublishError). */
  publish(match: MatchRecord): Promise<void>;
}

/** A failed publish. `retryable` is false when trying again cannot help (e.g. the document was rejected). */
export class MatchPublishError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MatchPublishError";
  }
}
