package com.dancesync.users.infrastructure.adapter.in.rest.admin;

import com.dancesync.users.domain.model.audit.AuditEvent;
import com.dancesync.users.domain.port.in.RecordAuditEventsUseCase;
import com.dancesync.users.domain.port.in.RecordAuditEventsUseCase.IngestResult;
import com.dancesync.users.infrastructure.audit.AuditProperties;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * Where the api-gateway and battle-service deliver their audit records (SEG-2), in batches,
 * service to service: the gateway has no route to {@code /internal/**} and
 * {@link com.dancesync.users.infrastructure.audit.InternalTokenFilter} requires the shared secret.
 *
 * <p>A batch is all or nothing: if any event is invalid nothing is stored and the producer gets
 * a 400 (it drops the batch: resending it would fail again). Resending a stored batch is safe:
 * events already in the log are skipped by id.
 */
@RestController
@RequestMapping("/internal/audit")
public class AuditIngestController {

    private final RecordAuditEventsUseCase recordEvents;
    private final AuditProperties properties;
    private final Clock clock;
    private final MeterRegistry registry;
    private final Counter duplicates;
    private final DistributionSummary lag;

    public AuditIngestController(RecordAuditEventsUseCase recordEvents, AuditProperties properties, Clock clock,
                                 MeterRegistry registry) {
        this.recordEvents = recordEvents;
        this.properties = properties;
        this.clock = clock;
        this.registry = registry;
        this.duplicates = Counter.builder("audit.records.duplicates")
                .description("Audit events resent by a producer and skipped because they were already stored")
                .register(registry);
        this.lag = DistributionSummary.builder("audit.ingest.lag")
                .description("Seconds from a request to its audit record being chained")
                .baseUnit("seconds")
                .publishPercentiles(0.5, 0.95, 0.99)
                .register(registry);
    }

    @PostMapping("/events")
    public ResponseEntity<IngestResult> ingest(@RequestBody IngestRequest request) {
        List<AuditEventRequest> received = request == null || request.events() == null ? List.of() : request.events();
        if (received.size() > properties.maxBatch()) {
            throw new IllegalArgumentException("A batch holds at most " + properties.maxBatch() + " events");
        }
        List<AuditEvent> events = new ArrayList<>(received.size());
        for (int i = 0; i < received.size(); i++) {
            try {
                events.add(received.get(i).toDomain());
            } catch (IllegalArgumentException | NullPointerException e) {
                throw new IllegalArgumentException("Event " + i + ": " + e.getMessage(), e);
            }
        }
        IngestResult result = recordEvents.record(events);
        var now = clock.instant();
        for (AuditEvent event : events) {
            Counter.builder("audit.records.ingested").description("Audit events chained, per producer")
                    .tag("producer", producerOf(event.source())).register(registry).increment();
            lag.record(Math.max(0, Duration.between(event.occurredAt(), now).toMillis()) / 1000.0);
        }
        duplicates.increment(result.duplicates());
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(result);
    }

    /** "battle-service@battle-1" -> "battle-service": a bounded metric label. */
    static String producerOf(String source) {
        int at = source.indexOf('@');
        String producer = at < 0 ? source : source.substring(0, at);
        return switch (producer) {
            case "api-gateway", "battle-service" -> producer;
            default -> "other";
        };
    }

    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail invalidBatch(IllegalArgumentException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, e.getMessage());
    }

    public record IngestRequest(List<AuditEventRequest> events) {
    }
}
