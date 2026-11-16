package com.dancesync.users.application.service;

import com.dancesync.users.domain.model.audit.AuditEvent;
import com.dancesync.users.domain.model.audit.AuditQuery;
import com.dancesync.users.domain.model.audit.AuditRecord;
import com.dancesync.users.domain.model.audit.AuditSummary;
import com.dancesync.users.domain.model.audit.ChainVerification;
import com.dancesync.users.domain.port.in.QueryAuditLogUseCase;
import com.dancesync.users.domain.port.in.RecordAuditEventsUseCase;
import com.dancesync.users.domain.port.in.VerifyAuditChainUseCase;
import com.dancesync.users.domain.port.out.AuditLogRepositoryPort;
import com.dancesync.users.domain.port.out.AuditLogRepositoryPort.Head;
import com.dancesync.users.domain.port.out.RegionResolverPort;
import com.dancesync.users.domain.service.AuditChain;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The audit log of SEG-2: the single writer of the hash chain, the reads of the admin screen and
 * the verification of the chain.
 *
 * <p>Appending happens under the repository's write lock (a PostgreSQL advisory lock), so several
 * users-service instances can receive batches at the same time and the chain still has exactly
 * one successor per record and no gaps.
 */
public class AuditService implements RecordAuditEventsUseCase, QueryAuditLogUseCase, VerifyAuditChainUseCase {

    /** The admin screen looks back at most a week at a time. */
    public static final int MAX_SUMMARY_HOURS = 168;

    private final AuditLogRepositoryPort repository;
    private final RegionResolverPort regions;
    private final AuditChain chain;
    private final Clock clock;
    /** Highest sequence number this instance has seen: a log that ends before it lost its tail. */
    private final AtomicLong highestSeenSeq = new AtomicLong();
    private final AtomicReference<ChainVerification> lastVerification = new AtomicReference<>();

    public AuditService(AuditLogRepositoryPort repository, RegionResolverPort regions, AuditChain chain, Clock clock) {
        this.repository = repository;
        this.regions = regions;
        this.chain = chain;
        this.clock = clock;
    }

    @Override
    @Transactional
    public IngestResult record(List<AuditEvent> events) {
        repository.lockForAppend();
        Optional<Head> head = repository.head();
        long seq = head.map(Head::seq).orElse(0L);
        String hash = head.map(Head::hash).orElse(AuditChain.GENESIS_HASH);
        if (events.isEmpty()) return new IngestResult(0, 0, seq);

        Set<UUID> seen = new HashSet<>(repository.existingEventIds(events.stream().map(AuditEvent::eventId).toList()));
        Instant now = clock.instant();
        List<AuditRecord> records = new ArrayList<>(events.size());
        int duplicates = 0;
        for (AuditEvent event : events) {
            // Already stored by an earlier attempt of the same batch, or twice in this one.
            if (!seen.add(event.eventId())) {
                duplicates++;
                continue;
            }
            AuditRecord record = chain.append(seq, hash, event, regions.regionOf(event.ip()), now);
            records.add(record);
            seq = record.seq();
            hash = record.hash();
        }
        if (!records.isEmpty()) repository.appendAll(records);
        long appendedHead = seq;
        afterCommit(() -> highestSeenSeq.accumulateAndGet(appendedHead, Math::max));
        return new IngestResult(records.size(), duplicates, seq);
    }

    @Override
    @Transactional(readOnly = true)
    public List<AuditRecord> search(AuditQuery query) {
        return repository.search(query);
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<AuditRecord> findBySeq(long seq) {
        return repository.findBySeq(seq);
    }

    @Override
    @Transactional(readOnly = true)
    public AuditSummary summarize(int windowHours) {
        int hours = Math.max(1, Math.min(windowHours, MAX_SUMMARY_HOURS));
        AuditSummary summary = repository.summarize(hours, clock.instant());
        highestSeenSeq.accumulateAndGet(summary.headSeq(), Math::max);
        return summary;
    }

    @Override
    @Transactional(readOnly = true)
    public ChainVerification verify() {
        // Read before the walk: everything seen so far is committed, so the walk's snapshot holds it,
        // while batches committed during the walk are past that snapshot and must not count as lost.
        long seenBeforeWalk = highestSeenSeq.get();
        AuditChain.Walk walk = chain.walk();
        repository.forEachInOrder(walk::accept);
        ChainVerification result = walk.finish(seenBeforeWalk);
        highestSeenSeq.accumulateAndGet(result.headSeq(), Math::max);
        lastVerification.set(result);
        return result;
    }

    @Override
    public Optional<ChainVerification> lastVerification() {
        return Optional.ofNullable(lastVerification.get());
    }

    /** Runs {@code action} once the current transaction commits (right away when there is none). */
    private static void afterCommit(Runnable action) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            action.run();
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                action.run();
            }
        });
    }

    /** Whether the chain is an HMAC (AUDIT_CHAIN_KEY set) or a plain SHA-256. */
    public boolean keyed() {
        return chain.keyed();
    }
}
