package com.dancesync.users.domain.port.out;

import com.dancesync.users.domain.model.audit.AuditQuery;
import com.dancesync.users.domain.model.audit.AuditRecord;
import com.dancesync.users.domain.model.audit.AuditSummary;

import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;

/**
 * Append-only storage of the audit chain (SEG-2). There is no update and no delete: the
 * database refuses them as well.
 */
public interface AuditLogRepositoryPort {

    /**
     * Takes the chain's write lock until the current transaction ends, so only one writer (in any
     * instance) reads the head and appends after it at a time. Must be called in a transaction.
     */
    void lockForAppend();

    /** The last record, or empty for an empty log. */
    Optional<Head> head();

    /** Which of these event ids are already in the log. */
    Set<UUID> existingEventIds(Collection<UUID> eventIds);

    void appendAll(List<AuditRecord> records);

    /** Feeds every record to {@code consumer} in ascending sequence order, without loading them all at once. */
    void forEachInOrder(Consumer<AuditRecord> consumer);

    List<AuditRecord> search(AuditQuery query);

    Optional<AuditRecord> findBySeq(long seq);

    AuditSummary summarize(int windowHours, Instant now);

    /**
     * Addresses with at least {@code threshold} requests or connections refused for lacking a valid
     * token (401 / UNAUTHORIZED) within {@code window} before {@code now}. Refusals of valid tokens
     * without the right (403) do not count: they are not a token being guessed.
     */
    List<Offender> rejectedBursts(Duration window, int threshold, Instant now);

    /** Clients blocked for flooding within {@code window} before {@code now}. */
    List<Offender> blockedClients(Duration window, Instant now);

    record Head(long seq, String hash, Instant recordedAt) {
    }

    /**
     * An address (and the user, when known) behind repeated incidents.
     *
     * @param firstAt first incident in the window
     * @param lastAt  last incident in the window
     */
    record Offender(String ip, String region, String userId, String userName, long count, Instant firstAt,
                    Instant lastAt) {
    }
}
