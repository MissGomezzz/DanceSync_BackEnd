package com.dancesync.users.domain.model.audit;

import java.time.Instant;
import java.util.Objects;

/**
 * An {@link AuditEvent} once chained (SEG-2): its place in the log ({@code seq}, without gaps),
 * the region resolved from its address, when it was recorded, and the hash that ties it to the
 * previous record. New records are built by {@link com.dancesync.users.domain.service.AuditChain};
 * the fields are kept exactly as given, so a record read back is hashed as stored.
 */
public record AuditRecord(
        long seq,
        AuditEvent event,
        Instant recordedAt,
        String region,
        String prevHash,
        String hash) {

    public AuditRecord {
        Objects.requireNonNull(event, "event must not be null");
        Objects.requireNonNull(recordedAt, "recordedAt must not be null");
        Objects.requireNonNull(prevHash, "prevHash must not be null");
        Objects.requireNonNull(hash, "hash must not be null");
        Objects.requireNonNull(region, "region must not be null");
        if (seq <= 0) throw new IllegalArgumentException("seq must be positive");
    }
}
