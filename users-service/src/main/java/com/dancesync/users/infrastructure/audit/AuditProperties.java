package com.dancesync.users.infrastructure.audit;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Settings of the audit log (SEG-2), bound from {@code dancesync.audit}.
 *
 * @param internalToken  shared secret of the internal calls: the producers' batches
 *                       ({@code /internal/audit/events}) and the admin requests the gateway forwards
 *                       ({@code /api/admin/**}). Empty: both are refused.
 * @param chainKey       HMAC key of the hash chain; empty: plain SHA-256
 * @param geoipDbPath    MaxMind-format GeoIP database; empty: public addresses get region "unknown"
 * @param prometheusUrl  Prometheus, for the operational alerts of the admin screen; empty: not shown
 * @param verifyInterval how often the whole chain is verified in the background
 * @param maxBatch       largest batch a producer may send
 */
@ConfigurationProperties("dancesync.audit")
public record AuditProperties(
        String internalToken,
        String chainKey,
        String geoipDbPath,
        String prometheusUrl,
        @DefaultValue("PT5M") Duration verifyInterval,
        @DefaultValue("500") int maxBatch,
        @DefaultValue Alerts alerts) {

    /** Smallest accepted secret: 32 bytes, like the guest token secret. */
    static final int MIN_SECRET_BYTES = 32;

    public AuditProperties {
        internalToken = internalToken == null ? "" : internalToken.trim();
        chainKey = chainKey == null ? "" : chainKey.trim();
        requireLongEnough("AUDIT_INTERNAL_TOKEN", internalToken);
        requireLongEnough("AUDIT_CHAIN_KEY", chainKey);
    }

    private static void requireLongEnough(String name, String secret) {
        if (!secret.isEmpty() && secret.getBytes(StandardCharsets.UTF_8).length < MIN_SECRET_BYTES) {
            throw new IllegalStateException(name + " must be at least " + MIN_SECRET_BYTES + " bytes long");
        }
    }

    public boolean internalCallsEnabled() {
        return !internalToken.isEmpty();
    }

    public byte[] chainKeyBytes() {
        return chainKey.getBytes(StandardCharsets.UTF_8);
    }

    /** When the audit log raises a security alert on the admin screen. */
    public record Alerts(
            @DefaultValue("PT15M") Duration rejectedWindow,
            @DefaultValue("10") int rejectedThreshold,
            @DefaultValue("PT1H") Duration blockedWindow) {
    }
}
