package com.dancesync.users.support;

import com.dancesync.users.domain.model.audit.AuditQuery;
import com.dancesync.users.domain.model.audit.AuditRecord;
import com.dancesync.users.domain.model.audit.AuditSummary;
import com.dancesync.users.domain.port.out.AuditLogRepositoryPort;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.stream.Collectors;

/** In-memory audit log with the same append-only contract; tests may tamper with it through {@link #replace}. */
public class InMemoryAuditLogRepository implements AuditLogRepositoryPort {

    private final List<AuditRecord> records = new ArrayList<>();

    @Override
    public synchronized void lockForAppend() {
        // Single-threaded tests: nothing to lock.
    }

    @Override
    public synchronized Optional<Head> head() {
        return records.isEmpty() ? Optional.empty()
                : Optional.of(records.get(records.size() - 1)).map(r -> new Head(r.seq(), r.hash(), r.recordedAt()));
    }

    @Override
    public synchronized Set<UUID> existingEventIds(Collection<UUID> eventIds) {
        return records.stream().map(r -> r.event().eventId()).filter(eventIds::contains).collect(Collectors.toSet());
    }

    @Override
    public synchronized void appendAll(List<AuditRecord> batch) {
        records.addAll(batch);
    }

    @Override
    public synchronized void forEachInOrder(Consumer<AuditRecord> consumer) {
        records.stream().sorted(Comparator.comparingLong(AuditRecord::seq)).forEach(consumer);
    }

    @Override
    public synchronized List<AuditRecord> search(AuditQuery query) {
        return records.stream()
                .filter(r -> query.user() == null || query.user().equals(r.event().userId()))
                .filter(r -> query.beforeSeq() == null || r.seq() < query.beforeSeq())
                .sorted(Comparator.comparingLong(AuditRecord::seq).reversed())
                .limit(query.limit())
                .toList();
    }

    @Override
    public synchronized Optional<AuditRecord> findBySeq(long seq) {
        return records.stream().filter(r -> r.seq() == seq).findFirst();
    }

    @Override
    public synchronized AuditSummary summarize(int windowHours, Instant now) {
        long head = records.isEmpty() ? 0 : records.get(records.size() - 1).seq();
        return new AuditSummary(windowHours, now.minus(Duration.ofHours(windowHours)), records.size(), Map.of(),
                Map.of(), 0, 0, List.of(), List.of(), List.of(), List.of(), List.of(), head, null);
    }

    @Override
    public List<Offender> rejectedBursts(Duration window, int threshold, Instant now) {
        return List.of();
    }

    @Override
    public List<Offender> blockedClients(Duration window, Instant now) {
        return List.of();
    }

    /** Simulates someone with write access to the storage. */
    public synchronized void replace(int index, AuditRecord record) {
        records.set(index, record);
    }

    public synchronized void remove(int index) {
        records.remove(index);
    }

    public synchronized List<AuditRecord> all() {
        return List.copyOf(records);
    }
}
