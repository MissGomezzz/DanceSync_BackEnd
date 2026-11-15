package com.dancesync.gateway.audit;

import java.time.Instant;
import java.util.UUID;

/**
 * One audited request, in the shape users-service ingests (SEG-2). The event id makes a batch
 * that is sent twice (no answer the first time) safe: users-service skips ids it already chained.
 */
public record AuditEntry(
        UUID eventId,
        Instant occurredAt,
        String source,
        String channel,
        String action,
        String resource,
        String outcome,
        Integer status,
        String code,
        String userId,
        String userKind,
        String userName,
        String ip,
        String userAgent,
        String correlationId,
        String detail) {

    /** JSON object for the ingestion batch. Built by hand: a dozen strings, no mapper needed. */
    String toJson() {
        StringBuilder out = new StringBuilder(400).append('{');
        field(out, "eventId", eventId.toString());
        field(out, "occurredAt", occurredAt.toString());
        field(out, "source", source);
        field(out, "channel", channel);
        field(out, "action", action);
        field(out, "resource", resource);
        field(out, "outcome", outcome);
        if (status != null) out.append("\"status\":").append(status).append(',');
        field(out, "code", code);
        field(out, "userId", userId);
        field(out, "userKind", userKind);
        field(out, "userName", userName);
        field(out, "ip", ip);
        field(out, "userAgent", userAgent);
        field(out, "correlationId", correlationId);
        field(out, "detail", detail);
        out.setLength(out.length() - 1);
        return out.append('}').toString();
    }

    private static void field(StringBuilder out, String name, String value) {
        if (value == null) return;
        out.append('"').append(name).append("\":\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                default -> {
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
                }
            }
        }
        out.append("\",");
    }
}
