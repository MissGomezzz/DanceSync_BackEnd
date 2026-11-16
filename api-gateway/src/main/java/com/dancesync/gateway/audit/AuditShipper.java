package com.dancesync.gateway.audit;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Delivers the gateway's audit records to users-service in batches (SEG-2), off the request path:
 * a request only puts its record in a bounded queue, and one background thread sends the queue
 * every {@code flushInterval} (about a second, well under the one minute SEG-2 allows to attribute
 * an action).
 *
 * <p>If users-service does not answer, the batch is kept and retried with a growing pause (up to
 * 30 s); resending is safe because users-service skips event ids it already has. Only when the
 * queue is full are new records dropped, counted in {@code gateway_audit_records_total{result="dropped"}}
 * and alerted on, so an outage of the audit store never takes the gateway down.
 */
@Component
public class AuditShipper {

    static final String HEADER = "X-Internal-Token";
    private static final Logger log = LoggerFactory.getLogger(AuditShipper.class);
    private static final long MAX_BACKOFF_MS = 30_000;
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(5);
    /** How long shutdown waits for a delivery in flight: one request timeout. */
    private static final Duration SHUTDOWN_WAIT = REQUEST_TIMEOUT;
    /** Largest batch users-service ingests (its dancesync.audit.max-batch); a bigger one is refused whole. */
    static final int MAX_INGEST_BATCH = 500;

    private final AuditProperties properties;
    private final int batchSize;
    private final BlockingQueue<AuditEntry> queue;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private final ScheduledExecutorService worker;
    private final Counter shipped;
    private final Counter dropped;
    private final Counter refused;
    /** The batch being delivered; kept until users-service accepts it. */
    private volatile List<AuditEntry> pending = List.of();
    private long backoffMs;
    private long nextAttemptAt;
    private boolean warnedNotConfigured;

    public AuditShipper(AuditProperties properties, MeterRegistry registry) {
        this.properties = properties;
        this.batchSize = Math.min(properties.batchSize(), MAX_INGEST_BATCH);
        if (properties.batchSize() > MAX_INGEST_BATCH) {
            log.atWarn().addKeyValue("configured", properties.batchSize()).addKeyValue("used", MAX_INGEST_BATCH)
                    .log("dancesync.audit.batch-size is above what users-service ingests; batches are capped");
        }
        this.queue = new ArrayBlockingQueue<>(properties.bufferCapacity());
        this.shipped = counter(registry, "shipped", "Audit records accepted by users-service");
        this.dropped = counter(registry, "dropped", "Audit records lost because the buffer was full");
        this.refused = counter(registry, "refused", "Audit records refused by users-service as invalid");
        Gauge.builder("gateway.audit.buffer.size", queue, q -> q.size() + pending.size())
                .description("Audit records waiting to be delivered to users-service")
                .register(registry);
        this.worker = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "audit-shipper");
            thread.setDaemon(true);
            return thread;
        });
        if (properties.enabled()) {
            long every = Math.max(50, properties.flushInterval().toMillis());
            worker.scheduleWithFixedDelay(this::flushSafely, every, every, TimeUnit.MILLISECONDS);
        }
    }

    private static Counter counter(MeterRegistry registry, String result, String description) {
        return Counter.builder("gateway.audit.records").description(description).tag("result", result).register(registry);
    }

    /** Never blocks the request: a full buffer drops the record and counts it. */
    public void submit(AuditEntry entry) {
        if (!properties.enabled()) return;
        if (!queue.offer(entry)) {
            dropped.increment();
            if (dropped.count() % 1000 == 1) {
                log.atError().addKeyValue("event", "audit.dropped").addKeyValue("dropped", (long) dropped.count())
                        .log("Audit buffer full: records are being dropped");
            }
        }
    }

    private void flushSafely() {
        flushSafely(false);
    }

    private void flushSafely(boolean ignoreBackoff) {
        try {
            flush(ignoreBackoff);
        } catch (RuntimeException e) {
            log.atWarn().addKeyValue("error", e.getClass().getSimpleName()).log("Audit flush failed");
        }
    }

    /** Sends everything queued, batch by batch, until the queue is empty or a delivery fails. */
    void flush() {
        flush(false);
    }

    /** @param ignoreBackoff try now even if the last delivery failed recently (the last attempt on shutdown) */
    private synchronized void flush(boolean ignoreBackoff) {
        if (!properties.shippingConfigured()) {
            if (!warnedNotConfigured && !queue.isEmpty()) {
                warnedNotConfigured = true;
                log.warn("AUDIT_INTERNAL_TOKEN is not set: audit records are kept in memory and not delivered");
            }
            return;
        }
        if (!ignoreBackoff && System.currentTimeMillis() < nextAttemptAt) return;
        while (true) {
            if (pending.isEmpty()) {
                List<AuditEntry> batch = new ArrayList<>(batchSize);
                queue.drainTo(batch, batchSize);
                if (batch.isEmpty()) return;
                pending = batch;
            }
            if (!deliver(pending)) {
                backoffMs = backoffMs == 0 ? 1000 : Math.min(MAX_BACKOFF_MS, backoffMs * 2);
                nextAttemptAt = System.currentTimeMillis() + backoffMs;
                return;
            }
            pending = List.of();
            backoffMs = 0;
            nextAttemptAt = 0;
        }
    }

    /** True when the batch is done with (stored, or refused as invalid and dropped). */
    private boolean deliver(List<AuditEntry> batch) {
        StringBuilder body = new StringBuilder(batch.size() * 400).append("{\"events\":[");
        for (int i = 0; i < batch.size(); i++) {
            if (i > 0) body.append(',');
            body.append(batch.get(i).toJson());
        }
        body.append("]}");
        HttpRequest request = HttpRequest.newBuilder(URI.create(properties.ingestUrl()))
                .timeout(REQUEST_TIMEOUT)
                .header("Content-Type", "application/json")
                .header(HEADER, properties.internalToken())
                .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
                .build();
        try {
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            int status = response.statusCode();
            if (status >= 200 && status < 300) {
                shipped.increment(batch.size());
                return true;
            }
            if (status == 400) {
                // Resending the same invalid batch would fail forever: drop it, loudly.
                refused.increment(batch.size());
                log.atError().addKeyValue("event", "audit.refused").addKeyValue("records", batch.size())
                        .addKeyValue("detail", response.body().length() > 300 ? response.body().substring(0, 300) : response.body())
                        .log("users-service refused an audit batch");
                return true;
            }
            log.atWarn().addKeyValue("status", status).addKeyValue("records", batch.size())
                    .log("users-service did not accept the audit batch; it will be retried");
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        } catch (Exception e) {
            log.atWarn().addKeyValue("error", e.getClass().getSimpleName()).addKeyValue("records", batch.size())
                    .log("users-service unreachable; the audit batch will be retried");
            return false;
        }
    }

    /** Records not delivered yet (queued plus the batch in flight). */
    public int backlog() {
        return queue.size() + pending.size();
    }

    /**
     * On shutdown: one last attempt to deliver what is queued, so a deploy loses nothing. A delivery
     * in flight is allowed to finish (up to one request timeout) rather than interrupted, and the
     * last attempt ignores the back-off of an earlier failure.
     */
    @PreDestroy
    void shutdown() {
        boolean interrupted = false;
        worker.shutdown();
        try {
            if (!worker.awaitTermination(SHUTDOWN_WAIT.toMillis(), TimeUnit.MILLISECONDS)) worker.shutdownNow();
        } catch (InterruptedException e) {
            worker.shutdownNow();
            interrupted = true;
        }
        flushSafely(true);
        // Restored only now: with the flag set, the last delivery would be abandoned right away.
        if (interrupted) Thread.currentThread().interrupt();
    }
}
