package com.dancesync.users.support;

import com.dancesync.users.domain.model.audit.AuditEvent;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditChannel;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditOutcome;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditUserKind;

import java.time.Instant;
import java.util.UUID;

/** Audit events for the SEG-2 tests. */
public final class AuditFixtures {

    public static final Instant AT = Instant.parse("2026-11-15T12:00:00.123Z");
    public static final String CHROME = "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0";

    private AuditFixtures() {
    }

    /** A vote cast by Ana, a registered user, from a public address. */
    public static AuditEvent vote(String userId) {
        return event(userId, "vote:cast", AuditOutcome.OK, "203.0.113.7");
    }

    public static AuditEvent event(String userId, String action, AuditOutcome outcome, String ip) {
        return AuditEvent.normalized(UUID.randomUUID(), AT, "battle-service@battle-1", AuditChannel.SOCKET_IO, action,
                "ABC123", outcome, null, null, userId, AuditUserKind.USER, nameOf(userId), ip, CHROME,
                "corr-" + UUID.randomUUID(), null);
    }

    /** "oid-ana" -> "Ana". */
    private static String nameOf(String userId) {
        if (userId == null) return null;
        String name = userId.startsWith("oid-") ? userId.substring(4) : userId;
        return Character.toUpperCase(name.charAt(0)) + name.substring(1);
    }

    public static AuditEvent httpRequest(String userId, String path, int status, AuditOutcome outcome, String ip) {
        return AuditEvent.normalized(UUID.randomUUID(), AT, "api-gateway@gw-1", AuditChannel.HTTP, "POST " + path, path,
                outcome, status, null, userId, AuditUserKind.USER, null, ip, CHROME, "corr-" + UUID.randomUUID(), null);
    }
}
