package com.dancesync.users.domain.port.in;

import com.dancesync.users.domain.model.audit.AuditQuery;
import com.dancesync.users.domain.model.audit.AuditRecord;
import com.dancesync.users.domain.model.audit.AuditSummary;

import java.util.List;
import java.util.Optional;

/** What the admin screen reads from the audit log (SEG-2). */
public interface QueryAuditLogUseCase {

    /** Matching records, newest first. */
    List<AuditRecord> search(AuditQuery query);

    Optional<AuditRecord> findBySeq(long seq);

    AuditSummary summarize(int windowHours);
}
