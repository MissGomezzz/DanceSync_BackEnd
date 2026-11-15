import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { AuditEntry, AuditTrail } from "../../application/ports/AuditTrail.js";
import type { Logger } from "../../application/ports/Logger.js";
import { rootLogger, SERVICE_NAME } from "../logging/logger.js";
import type { AuditConfig } from "./auditConfig.js";

/** One record in the shape users-service ingests (POST /internal/audit/events). */
export interface AuditWireRecord extends AuditEntry {
  eventId: string;
  occurredAt: string;
  source: string;
  channel: "socket.io";
}

export interface AuditShipperStats {
  shipped: number;
  dropped: number;
  refused: number;
  backlog: number;
}

const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
/** Longest User-Agent kept; users-service cuts at 512 too. */
const MAX_USER_AGENT = 512;

/**
 * Delivers the audit records of this replica to users-service in batches (SEG-2), off the event path:
 * `record` only stamps the entry (event id, UTC time of this server, service and replica) and queues
 * it; a timer sends the queue every `flushIntervalMs` (about a second, well under the one minute
 * SEG-2 allows to attribute an action).
 *
 * If users-service does not answer, the batch is kept and retried with a growing pause (up to
 * 30 s); resending is safe because users-service skips event ids it already has. Only a full buffer
 * drops records, counted in `dancesync_audit_records_total{result="dropped"}`, so an outage of the
 * audit store never stops a battle. `close()` (graceful shutdown) makes one last delivery attempt.
 */
export class HttpAuditShipper implements AuditTrail {
  private readonly queue: AuditWireRecord[] = [];
  private pending: AuditWireRecord[] = [];
  private readonly source = `${SERVICE_NAME}@${hostname()}`;
  private readonly timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | null = null;
  private backoffMs = 0;
  private nextAttemptAt = 0;
  private warnedNotConfigured = false;
  private readonly stats = { shipped: 0, dropped: 0, refused: 0 };

  constructor(
    private readonly config: AuditConfig,
    private readonly options: {
      logger?: Logger;
      /** Called with how many records ended each way (metrics). */
      onResult?: (result: "shipped" | "dropped" | "refused", count: number) => void;
      fetchImpl?: typeof fetch;
      now?: () => Date;
    } = {},
  ) {
    if (config.enabled) {
      this.timer = setInterval(() => void this.flush(), config.flushIntervalMs);
      this.timer.unref();
    }
  }

  record(entry: AuditEntry): void {
    if (!this.config.enabled) return;
    if (this.queue.length >= this.config.bufferCapacity) {
      this.stats.dropped += 1;
      this.options.onResult?.("dropped", 1);
      if (this.stats.dropped % 1000 === 1) {
        this.logger.error({ event: "audit.dropped", dropped: this.stats.dropped }, "Audit buffer full: records are being dropped");
      }
      return;
    }
    this.queue.push({
      ...entry,
      userAgent: entry.userAgent?.slice(0, MAX_USER_AGENT),
      eventId: randomUUID(),
      occurredAt: (this.options.now?.() ?? new Date()).toISOString(),
      source: this.source,
      channel: "socket.io",
    });
  }

  /** Sends everything queued, batch by batch, until the queue is empty or a delivery fails. Never rejects. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  getStats(): AuditShipperStats {
    return { ...this.stats, backlog: this.queue.length + this.pending.length };
  }

  /** Stops the timer and makes one last delivery attempt (graceful shutdown). */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.nextAttemptAt = 0;
    await this.flush();
  }

  private get logger(): Logger {
    return this.options.logger ?? rootLogger;
  }

  private async drain(): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.config.internalToken) {
      if (!this.warnedNotConfigured && this.queue.length > 0) {
        this.warnedNotConfigured = true;
        this.logger.warn({}, "AUDIT_INTERNAL_TOKEN is not set: audit records are kept in memory and not delivered");
      }
      return;
    }
    if (Date.now() < this.nextAttemptAt) return;
    for (;;) {
      if (this.pending.length === 0) {
        this.pending = this.queue.splice(0, this.config.batchSize);
        if (this.pending.length === 0) return;
      }
      if (!(await this.deliver(this.pending))) {
        this.backoffMs = this.backoffMs === 0 ? 1000 : Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
        this.nextAttemptAt = Date.now() + this.backoffMs;
        return;
      }
      this.pending = [];
      this.backoffMs = 0;
      this.nextAttemptAt = 0;
    }
  }

  /** True when the batch is done with (stored, or refused as invalid and dropped). */
  private async deliver(batch: AuditWireRecord[]): Promise<boolean> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(this.config.ingestUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": this.config.internalToken },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await response.text().catch(() => "");
      if (response.ok) {
        this.stats.shipped += batch.length;
        this.options.onResult?.("shipped", batch.length);
        return true;
      }
      if (response.status === 400) {
        // Resending the same invalid batch would fail forever: drop it, loudly.
        this.stats.refused += batch.length;
        this.options.onResult?.("refused", batch.length);
        this.logger.error({ event: "audit.refused", records: batch.length, detail: body.slice(0, 300) }, "users-service refused an audit batch");
        return true;
      }
      this.logger.warn({ status: response.status, records: batch.length }, "users-service did not accept the audit batch; it will be retried");
      return false;
    } catch (error) {
      this.logger.warn({ err: error, records: batch.length }, "users-service unreachable; the audit batch will be retried");
      return false;
    }
  }
}
