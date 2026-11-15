package com.dancesync.gateway.audit;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Audit trail of the gateway (SEG-2), bound from {@code dancesync.audit}.
 *
 * @param enabled        record every request (true by default)
 * @param ingestUrl      users-service endpoint that chains the records
 * @param internalToken  shared secret of the internal calls (AUDIT_INTERNAL_TOKEN), also added to the
 *                       admin requests forwarded to users-service. Empty: records are kept in memory
 *                       until it is set, and the admin API answers 503.
 * @param flushInterval  how often the buffer is sent
 * @param batchSize      records per request to users-service
 * @param bufferCapacity records kept while users-service cannot be reached; beyond it new ones are
 *                       dropped (and counted) so the gateway never runs out of memory
 */
@ConfigurationProperties("dancesync.audit")
public record AuditProperties(
        @DefaultValue("true") boolean enabled,
        @DefaultValue("http://localhost:8081/internal/audit/events") String ingestUrl,
        @DefaultValue("") String internalToken,
        @DefaultValue("PT1S") Duration flushInterval,
        @DefaultValue("200") int batchSize,
        @DefaultValue("20000") int bufferCapacity) {

    static final int MIN_SECRET_BYTES = 32;

    public AuditProperties {
        internalToken = internalToken == null ? "" : internalToken.trim();
        if (!internalToken.isEmpty() && internalToken.getBytes(StandardCharsets.UTF_8).length < MIN_SECRET_BYTES) {
            throw new IllegalStateException("AUDIT_INTERNAL_TOKEN must be at least " + MIN_SECRET_BYTES + " bytes long");
        }
        if (batchSize <= 0 || bufferCapacity <= 0) {
            throw new IllegalStateException("dancesync.audit.batch-size and buffer-capacity must be positive");
        }
    }

    public boolean shippingConfigured() {
        return !internalToken.isEmpty();
    }
}
