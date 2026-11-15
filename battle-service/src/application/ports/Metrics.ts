/** Who a connection or a session belongs to: a signed-in user or a guest. */
export type UserKind = "user" | "guest";

/** How a word race round ended. */
export type WordRoundOutcome = "won" | "expired";

/** What the abuse protection (SEG-3) did. */
export type AbuseAction = "limited" | "blocked" | "refused";

/** Where an unexpected error happened; a bounded set, so it can be a metric label. */
export type ErrorSource = "socket" | "http" | "timer" | "sweep" | "redis" | "process";

/** Outcome of an optimistic room update that lost a race against another writer. */
export type RoomConflictResult = "retry" | "failure";

/**
 * Outbound port for the business and technical metrics (OBS-1). Named after
 * what happened, not after a metrics library, so the use cases and handlers
 * stay free of it; the Prometheus adapter decides the metric names. No method
 * takes an id (room, user, correlation): ids belong in the logs, and every
 * label here comes from a small fixed set.
 */
export interface Metrics {
  socketConnected(kind: UserKind): void;
  socketDisconnected(kind: UserKind): void;
  /** A guest got a token, or a signed-in user connected after 30 min without a connection. */
  sessionStarted(kind: UserKind): void;
  battleStarted(): void;
  /** From the moment dancing began to the finish. */
  battleFinished(durationSeconds: number): void;
  voteCast(): void;
  /** Counted only by the replica whose atomic transition ended the round. */
  wordRoundEnded(outcome: WordRoundOutcome): void;
  /** A client event handled, from receiving it to replying; `event` is a known event name. */
  socketEventHandled(event: string, durationSeconds: number): void;
  /** `route` is the route template (or "unmatched"), never a raw path. */
  httpRequestHandled(method: string, route: string, status: number, durationSeconds: number): void;
  error(source: ErrorSource): void;
  authRejected(channel: "http" | "socket.io"): void;
  abuse(action: AbuseAction): void;
  /** Rooms in the shared store, read by the sweep (the same on every replica). */
  roomsActive(count: number): void;
  /** Finished matches not delivered to the match history yet (DIS-1 outbox). */
  matchOutboxPending(count: number): void;
  roomConflict(result: RoomConflictResult): void;
}

/** Records nothing; for harnesses and as the default. */
export const noopMetrics: Metrics = {
  socketConnected() {},
  socketDisconnected() {},
  sessionStarted() {},
  battleStarted() {},
  battleFinished() {},
  voteCast() {},
  wordRoundEnded() {},
  socketEventHandled() {},
  httpRequestHandled() {},
  error() {},
  authRejected() {},
  abuse() {},
  roomsActive() {},
  matchOutboxPending() {},
  roomConflict() {},
};
