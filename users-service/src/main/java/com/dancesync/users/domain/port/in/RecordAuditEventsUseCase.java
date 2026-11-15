package com.dancesync.users.domain.port.in;

import com.dancesync.users.domain.model.audit.AuditEvent;

import java.util.List;

/** Appends the requests reported by the api-gateway and battle-service to the audit chain (SEG-2). */
public interface RecordAuditEventsUseCase {

    /**
     * Chains the events in the given order. An event whose id is already in the log is skipped,
     * so a producer can resend a batch it is not sure was stored.
     */
    IngestResult record(List<AuditEvent> events);

    /** How many events were appended and how many were already there. */
    record IngestResult(int appended, int duplicates, long headSeq) {
    }
}
