import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type {
  AbuseAction,
  AuditDelivery,
  ErrorSource,
  Metrics,
  RoomConflictResult,
  UserKind,
  WordRoundOutcome,
} from "../../application/ports/Metrics.js";

/** Latency buckets around the REN-1 target (p95 <= 300 ms), in seconds. */
const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5];
/** Battles last a song clip: about one to a few minutes. */
const BATTLE_BUCKETS = [15, 30, 60, 90, 120, 180, 240, 300, 600];

const USER_KINDS: UserKind[] = ["user", "guest"];
const OUTCOMES: WordRoundOutcome[] = ["won", "expired"];
const ABUSE_ACTIONS: AbuseAction[] = ["limited", "blocked", "refused"];
const ERROR_SOURCES: ErrorSource[] = ["socket", "http", "timer", "sweep", "redis", "process"];
const CONFLICT_RESULTS: RoomConflictResult[] = ["retry", "failure"];
const AUTH_CHANNELS = ["http", "socket.io"] as const;

export interface PromMetricsOptions {
  /** process_*, nodejs_* (CPU, memory, event loop lag). Default true. */
  defaultMetrics?: boolean;
}

/**
 * Prometheus adapter of the Metrics port (OBS-1), with its own registry so it
 * is served only by the metrics server (never by the public app) and tests can
 * build as many as they like. Every series of a known label value starts at 0,
 * so dashboards and rate() see it before the first event.
 */
export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly socketConnections: Gauge<"kind">;
  private readonly roomsActiveGauge: Gauge;
  private readonly battlesStarted: Counter;
  private readonly sessionsStarted: Counter<"kind">;
  private readonly votes: Counter;
  private readonly wordRounds: Counter<"outcome">;
  private readonly socketEvents: Counter<"event">;
  private readonly battleDuration: Histogram;
  private readonly httpDuration: Histogram<"method" | "route" | "status">;
  private readonly socketEventDuration: Histogram<"event">;
  private readonly errors: Counter<"source">;
  private readonly authRejections: Counter<"channel">;
  private readonly abuseEvents: Counter<"action">;
  private readonly outboxPending: Gauge;
  private readonly roomConflicts: Counter<"result">;
  private readonly auditRecordsTotal: Counter<"result">;

  constructor(options: PromMetricsOptions = {}) {
    if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry });
    const registers = [this.registry];

    this.socketConnections = new Gauge({
      name: "dancesync_socket_connections",
      help: "Open Socket.IO connections on this replica, by user kind",
      labelNames: ["kind"],
      registers,
    });
    this.roomsActiveGauge = new Gauge({
      name: "dancesync_rooms_active",
      help: "Rooms in the shared store, read by the last sweep (same value on every replica: use max())",
      registers,
    });
    this.battlesStarted = new Counter({ name: "dancesync_battles_started_total", help: "Battles started", registers });
    this.sessionsStarted = new Counter({
      name: "dancesync_sessions_started_total",
      help: "Sessions started: guest tokens issued and signed-in users connecting after 30 min away",
      labelNames: ["kind"],
      registers,
    });
    this.votes = new Counter({ name: "dancesync_votes_total", help: "Spectator votes applied", registers });
    this.wordRounds = new Counter({
      name: "dancesync_word_rounds_total",
      help: "Word race rounds ended, counted once by the replica whose transition applied",
      labelNames: ["outcome"],
      registers,
    });
    this.socketEvents = new Counter({
      name: "dancesync_socket_events_total",
      help: "Socket.IO client events handled, by event",
      labelNames: ["event"],
      registers,
    });
    this.battleDuration = new Histogram({
      name: "dancesync_battle_duration_seconds",
      help: "Battle duration from the start of the dancing to the finish",
      buckets: BATTLE_BUCKETS,
      registers,
    });
    this.httpDuration = new Histogram({
      name: "dancesync_http_request_duration_seconds",
      help: "HTTP request duration, by method, route template and status",
      labelNames: ["method", "route", "status"],
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.socketEventDuration = new Histogram({
      name: "dancesync_socket_event_duration_seconds",
      help: "Socket.IO event latency inside battle-service, from receiving the event to replying",
      labelNames: ["event"],
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.errors = new Counter({
      name: "dancesync_errors_total",
      help: "Unexpected errors, by where they happened",
      labelNames: ["source"],
      registers,
    });
    this.authRejections = new Counter({
      name: "dancesync_auth_rejected_total",
      help: "Refused authentication or authorization attempts (SEG-1), by channel",
      labelNames: ["channel"],
      registers,
    });
    this.abuseEvents = new Counter({
      name: "dancesync_abuse_events_total",
      help: "Abuse protection incidents (SEG-3), by action",
      labelNames: ["action"],
      registers,
    });
    this.outboxPending = new Gauge({
      name: "dancesync_match_outbox_pending",
      help: "Finished matches waiting to be delivered to users-service (shared outbox)",
      registers,
    });
    this.roomConflicts = new Counter({
      name: "dancesync_room_conflicts_total",
      help: "Room updates that lost an optimistic-lock race: retried, or failed after every attempt",
      labelNames: ["result"],
      registers,
    });

    for (const kind of USER_KINDS) {
      this.socketConnections.set({ kind }, 0);
      this.sessionsStarted.inc({ kind }, 0);
    }
    for (const outcome of OUTCOMES) this.wordRounds.inc({ outcome }, 0);
    this.auditRecordsTotal = new Counter({
      name: "dancesync_audit_records_total",
      help: "Audit records (SEG-2) delivered to users-service, dropped because the buffer was full, or refused as invalid",
      labelNames: ["result"],
      registers,
    });
    for (const result of ["shipped", "dropped", "refused"]) this.auditRecordsTotal.inc({ result }, 0);
    for (const action of ABUSE_ACTIONS) this.abuseEvents.inc({ action }, 0);
    for (const source of ERROR_SOURCES) this.errors.inc({ source }, 0);
    for (const result of CONFLICT_RESULTS) this.roomConflicts.inc({ result }, 0);
    for (const channel of AUTH_CHANNELS) this.authRejections.inc({ channel }, 0);
  }

  socketConnected(kind: UserKind): void {
    this.socketConnections.inc({ kind });
  }
  socketDisconnected(kind: UserKind): void {
    this.socketConnections.dec({ kind });
  }
  sessionStarted(kind: UserKind): void {
    this.sessionsStarted.inc({ kind });
  }
  battleStarted(): void {
    this.battlesStarted.inc();
  }
  battleFinished(durationSeconds: number): void {
    this.battleDuration.observe(durationSeconds);
  }
  voteCast(): void {
    this.votes.inc();
  }
  wordRoundEnded(outcome: WordRoundOutcome): void {
    this.wordRounds.inc({ outcome });
  }
  socketEventHandled(event: string, durationSeconds: number): void {
    this.socketEvents.inc({ event });
    this.socketEventDuration.observe({ event }, durationSeconds);
  }
  httpRequestHandled(method: string, route: string, status: number, durationSeconds: number): void {
    this.httpDuration.observe({ method, route, status: String(status) }, durationSeconds);
  }
  error(source: ErrorSource): void {
    this.errors.inc({ source });
  }
  authRejected(channel: "http" | "socket.io"): void {
    this.authRejections.inc({ channel });
  }
  abuse(action: AbuseAction): void {
    this.abuseEvents.inc({ action });
  }
  roomsActive(count: number): void {
    this.roomsActiveGauge.set(count);
  }
  matchOutboxPending(count: number): void {
    this.outboxPending.set(count);
  }
  auditRecords(result: AuditDelivery, count: number): void {
    this.auditRecordsTotal.inc({ result }, count);
  }
  roomConflict(result: RoomConflictResult): void {
    this.roomConflicts.inc({ result });
  }
}
