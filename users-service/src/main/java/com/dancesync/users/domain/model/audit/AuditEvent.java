package com.dancesync.users.domain.model.audit;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * One request to the backend as reported by the service that handled it (SEG-2), before it is
 * chained: the api-gateway reports every HTTP request, battle-service every Socket.IO handshake
 * and event. The user comes from the validated token (never from what the client claims), the
 * address from the trusted proxies' {@code X-Forwarded-For} and the time from the server clock.
 *
 * <p>{@link #normalized} trims texts and cuts them to the column sizes, so a long User-Agent or
 * path can never make a whole batch fail, and truncates the instant to milliseconds, so the
 * stored value and the one that was hashed are always the same.
 */
public record AuditEvent(
        UUID eventId,
        Instant occurredAt,
        String source,
        AuditChannel channel,
        String action,
        String resource,
        AuditOutcome outcome,
        Integer status,
        String code,
        String userId,
        AuditUserKind userKind,
        String userName,
        String ip,
        String userAgent,
        String correlationId,
        String detail) {

    public static final String UNKNOWN = "unknown";

    /**
     * Only checks what can never be missing. The cleaning happens in {@link #normalized}: a record
     * read back from the database must be hashed exactly as stored, so a value changed there
     * (even by a trailing space) is detected.
     */
    public AuditEvent {
        Objects.requireNonNull(eventId, "eventId must not be null");
        Objects.requireNonNull(occurredAt, "occurredAt must not be null");
        Objects.requireNonNull(source, "source must not be null");
        Objects.requireNonNull(channel, "channel must not be null");
        Objects.requireNonNull(action, "action must not be null");
        Objects.requireNonNull(outcome, "outcome must not be null");
        Objects.requireNonNull(userKind, "userKind must not be null");
        Objects.requireNonNull(ip, "ip must not be null");
        Objects.requireNonNull(userAgent, "userAgent must not be null");
    }

    /** An event as reported by a producer, cleaned and cut to the column sizes. */
    @SuppressWarnings("java:S107") // one parameter per audited field, mirrored by the table
    public static AuditEvent normalized(UUID eventId, Instant occurredAt, String source, AuditChannel channel,
                                        String action, String resource, AuditOutcome outcome, Integer status,
                                        String code, String userId, AuditUserKind userKind, String userName,
                                        String ip, String userAgent, String correlationId, String detail) {
        Objects.requireNonNull(occurredAt, "occurredAt must not be null");
        String user = optional(userId, 128);
        // No user id means nobody proved who they were, whatever kind was reported.
        AuditUserKind kind = user == null ? AuditUserKind.ANONYMOUS
                : userKind == null || userKind == AuditUserKind.ANONYMOUS ? AuditUserKind.USER : userKind;
        return new AuditEvent(eventId, occurredAt.truncatedTo(ChronoUnit.MILLIS), required(source, "source", 64),
                channel, required(action, "action", 128), optional(resource, 256), outcome, status,
                optional(code, 64), user, kind, user == null ? null : optional(userName, 128), orUnknown(ip, 64),
                orUnknown(userAgent, 512), optional(correlationId, 64), optional(detail, 512));
    }

    private static String required(String value, String field, int max) {
        String text = optional(value, max);
        if (text == null) throw new IllegalArgumentException(field + " must not be blank");
        return text;
    }

    private static String orUnknown(String value, int max) {
        String text = optional(value, max);
        return text == null ? UNKNOWN : text;
    }

    /** Trimmed, control characters replaced, cut to {@code max} characters; null when blank. */
    public static String optional(String value, int max) {
        if (value == null) return null;
        StringBuilder clean = new StringBuilder(Math.min(value.length(), max));
        for (int i = 0; i < value.length() && clean.length() < max; i++) {
            char c = value.charAt(i);
            clean.append(Character.isISOControl(c) ? ' ' : c);
        }
        String text = clean.toString().trim();
        return text.isEmpty() ? null : text;
    }

    /** Where the request came in. */
    public enum AuditChannel {
        HTTP("http"), SOCKET_IO("socket.io");

        private final String wire;

        AuditChannel(String wire) {
            this.wire = wire;
        }

        public String wire() {
            return wire;
        }

        public static AuditChannel fromWire(String value) {
            for (AuditChannel channel : values()) {
                if (channel.wire.equalsIgnoreCase(value)) return channel;
            }
            throw new IllegalArgumentException("Unknown audit channel: " + value);
        }
    }

    /** What happened to the request. */
    public enum AuditOutcome {
        /** Handled. */
        OK,
        /** Refused by the rules of the game or invalid (4xx other than 401/403/429, domain errors). */
        FAILED,
        /** No valid token, or the token does not allow it (401 / 403, UNAUTHORIZED / FORBIDDEN). */
        REJECTED,
        /** Dropped by the rate limit (429, SEG-3 events over the token bucket). */
        RATE_LIMITED,
        /** The client was blocked for flooding, or a blocked client tried again. */
        BLOCKED,
        /** The server failed (5xx, unexpected error). */
        ERROR;

        private static final Set<AuditOutcome> SECURITY = Set.of(REJECTED, RATE_LIMITED, BLOCKED);

        public String wire() {
            return name().toLowerCase(Locale.ROOT);
        }

        /** Refusals that belong on the security view of the admin screen. */
        public boolean isSecurityIncident() {
            return SECURITY.contains(this);
        }

        public static AuditOutcome fromWire(String value) {
            return valueOf(value.trim().toUpperCase(Locale.ROOT));
        }
    }

    /** Who acted, as proven by the token. */
    public enum AuditUserKind {
        USER, GUEST, ANONYMOUS;

        public String wire() {
            return name().toLowerCase(Locale.ROOT);
        }

        public static AuditUserKind fromWire(String value) {
            if (value == null || value.isBlank()) return null;
            return valueOf(value.trim().toUpperCase(Locale.ROOT));
        }
    }
}
