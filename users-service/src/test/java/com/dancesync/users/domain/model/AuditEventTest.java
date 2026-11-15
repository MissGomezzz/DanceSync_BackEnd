package com.dancesync.users.domain.model;

import com.dancesync.users.domain.model.audit.AuditEvent;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditChannel;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditOutcome;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditUserKind;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AuditEventTest {

    private static AuditEvent normalized(String userId, AuditUserKind kind, String userAgent, String ip) {
        return AuditEvent.normalized(UUID.randomUUID(), Instant.parse("2026-11-15T12:00:00.123456Z"), " api-gateway ",
                AuditChannel.HTTP, "GET /api/matches", null, AuditOutcome.OK, 200, null, userId, kind, "Ana", ip,
                userAgent, null, null);
    }

    @Test
    void cleansTextsAndKeepsMilliseconds() {
        AuditEvent event = normalized("oid-1", AuditUserKind.USER, "Chrome\n\tinjected", "203.0.113.7");

        assertThat(event.source()).isEqualTo("api-gateway");
        assertThat(event.userAgent()).isEqualTo("Chrome  injected");
        assertThat(event.occurredAt()).isEqualTo(Instant.parse("2026-11-15T12:00:00.123Z"));
    }

    @Test
    void withoutAUserIdTheRequestIsAnonymousWhateverWasReported() {
        AuditEvent event = normalized(" ", AuditUserKind.GUEST, "Chrome", "203.0.113.7");

        assertThat(event.userId()).isNull();
        assertThat(event.userKind()).isEqualTo(AuditUserKind.ANONYMOUS);
        // A name without a proven identity is not kept: it would look like an attribution.
        assertThat(event.userName()).isNull();
    }

    @Test
    void missingAddressAndBrowserAreRecordedAsUnknown() {
        AuditEvent event = normalized("oid-1", null, null, "");

        assertThat(event.ip()).isEqualTo(AuditEvent.UNKNOWN);
        assertThat(event.userAgent()).isEqualTo(AuditEvent.UNKNOWN);
        assertThat(event.userKind()).isEqualTo(AuditUserKind.USER);
    }

    @Test
    void longValuesAreCutToTheColumnSize() {
        AuditEvent event = normalized("oid-1", AuditUserKind.USER, "x".repeat(2000), "203.0.113.7");

        assertThat(event.userAgent()).hasSize(512);
    }

    @Test
    void anActionIsRequired() {
        assertThatThrownBy(() -> AuditEvent.normalized(UUID.randomUUID(), Instant.now(), "gw", AuditChannel.HTTP, " ",
                null, AuditOutcome.OK, null, null, null, null, null, null, null, null, null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void wireNamesRoundTrip() {
        assertThat(AuditChannel.fromWire("socket.io")).isEqualTo(AuditChannel.SOCKET_IO);
        assertThat(AuditOutcome.fromWire("rate_limited")).isEqualTo(AuditOutcome.RATE_LIMITED);
        assertThat(AuditOutcome.RATE_LIMITED.isSecurityIncident()).isTrue();
        assertThat(AuditOutcome.FAILED.isSecurityIncident()).isFalse();
        assertThatThrownBy(() -> AuditChannel.fromWire("smtp")).isInstanceOf(IllegalArgumentException.class);
    }
}
