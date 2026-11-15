package com.dancesync.users.infrastructure.adapter.in.rest.admin;

import com.dancesync.users.domain.model.audit.AuditEvent;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditChannel;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditOutcome;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditUserKind;

import java.time.Instant;
import java.util.UUID;

/** One request as a producer (api-gateway, battle-service) reports it in a batch (SEG-2). */
public record AuditEventRequest(
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

    /** @throws IllegalArgumentException when a required field is missing or a value is unknown */
    public AuditEvent toDomain() {
        if (eventId == null) throw new IllegalArgumentException("eventId is required");
        if (occurredAt == null) throw new IllegalArgumentException("occurredAt is required");
        if (channel == null || outcome == null) throw new IllegalArgumentException("channel and outcome are required");
        return AuditEvent.normalized(eventId, occurredAt, source, AuditChannel.fromWire(channel), action, resource,
                AuditOutcome.fromWire(outcome), status, code, userId, AuditUserKind.fromWire(userKind), userName, ip,
                userAgent, correlationId, detail);
    }
}
