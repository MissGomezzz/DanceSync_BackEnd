package com.dancesync.users.domain.model.audit;

import com.dancesync.users.domain.model.audit.AuditEvent.AuditChannel;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditOutcome;

import java.time.Instant;
import java.util.Set;

/**
 * Filters of the admin screen over the audit log, newest first. Every filter is optional.
 *
 * @param user          user id (exact) or part of the user's name
 * @param action        part of the action ("vote", "POST /api/rooms")
 * @param outcomes      any of these outcomes
 * @param channel       http or socket.io
 * @param ip            exact address
 * @param correlationId exact correlation id
 * @param from          occurred at or after
 * @param to            occurred before
 * @param beforeSeq     keyset pagination: records older than this one
 * @param limit         page size, 1 to {@link #MAX_LIMIT}
 */
public record AuditQuery(
        String user,
        String action,
        Set<AuditOutcome> outcomes,
        AuditChannel channel,
        String ip,
        String correlationId,
        Instant from,
        Instant to,
        Long beforeSeq,
        int limit) {

    public static final int DEFAULT_LIMIT = 50;
    public static final int MAX_LIMIT = 200;

    public AuditQuery {
        user = blankToNull(user);
        action = blankToNull(action);
        ip = blankToNull(ip);
        correlationId = blankToNull(correlationId);
        outcomes = outcomes == null ? Set.of() : Set.copyOf(outcomes);
        limit = limit <= 0 ? DEFAULT_LIMIT : Math.min(limit, MAX_LIMIT);
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
}
