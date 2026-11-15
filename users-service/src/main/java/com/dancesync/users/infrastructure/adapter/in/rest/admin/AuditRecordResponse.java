package com.dancesync.users.infrastructure.adapter.in.rest.admin;

import com.dancesync.users.domain.model.audit.AuditEvent;
import com.dancesync.users.domain.model.audit.AuditRecord;

import java.time.Instant;
import java.util.UUID;

/** One audit record as the admin screen shows it, with its link in the chain. */
public record AuditRecordResponse(
        long seq,
        UUID eventId,
        Instant occurredAt,
        Instant recordedAt,
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
        String region,
        String userAgent,
        String correlationId,
        String detail,
        String prevHash,
        String hash) {

    public static AuditRecordResponse from(AuditRecord record) {
        AuditEvent e = record.event();
        return new AuditRecordResponse(record.seq(), e.eventId(), e.occurredAt(), record.recordedAt(), e.source(),
                e.channel().wire(), e.action(), e.resource(), e.outcome().wire(), e.status(), e.code(), e.userId(),
                e.userKind().wire(), e.userName(), e.ip(), record.region(), e.userAgent(), e.correlationId(),
                e.detail(), record.prevHash(), record.hash());
    }
}
