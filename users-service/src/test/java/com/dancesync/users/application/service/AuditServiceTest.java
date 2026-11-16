package com.dancesync.users.application.service;

import com.dancesync.users.domain.model.audit.AuditEvent;
import com.dancesync.users.domain.model.audit.AuditRecord;
import com.dancesync.users.domain.model.audit.ChainVerification;
import com.dancesync.users.domain.model.audit.ChainVerification.Problem;
import com.dancesync.users.domain.port.in.RecordAuditEventsUseCase.IngestResult;
import com.dancesync.users.domain.service.AuditChain;
import com.dancesync.users.support.InMemoryAuditLogRepository;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static com.dancesync.users.support.AuditFixtures.vote;
import static org.assertj.core.api.Assertions.assertThat;

class AuditServiceTest {

    private final InMemoryAuditLogRepository repository = new InMemoryAuditLogRepository();
    private final AuditService service = new AuditService(repository, ip -> "Region of " + ip, new AuditChain(null),
            Clock.fixed(Instant.parse("2026-11-15T12:00:05Z"), ZoneOffset.UTC));

    @Test
    void chainsEveryEventAndResolvesItsRegion() {
        IngestResult result = service.record(List.of(vote("ana"), vote("bob")));

        assertThat(result.appended()).isEqualTo(2);
        assertThat(result.headSeq()).isEqualTo(2);
        List<AuditRecord> stored = repository.all();
        assertThat(stored).extracting(AuditRecord::seq).containsExactly(1L, 2L);
        assertThat(stored.get(0).region()).isEqualTo("Region of 203.0.113.7");
        assertThat(stored.get(1).prevHash()).isEqualTo(stored.get(0).hash());
        assertThat(stored.get(0).recordedAt()).isEqualTo(Instant.parse("2026-11-15T12:00:05Z"));
    }

    @Test
    void theChainContinuesAcrossBatches() {
        service.record(List.of(vote("ana")));
        service.record(List.of(vote("bob"), vote("cam")));

        assertThat(repository.all()).extracting(AuditRecord::seq).containsExactly(1L, 2L, 3L);
        assertThat(service.verify().valid()).isTrue();
    }

    @Test
    void aResentBatchIsNotStoredTwice() {
        AuditEvent ana = vote("ana");
        AuditEvent bob = vote("bob");
        service.record(List.of(ana, bob));

        // The producer did not get the answer and sends the batch again, plus a new event.
        IngestResult retry = service.record(List.of(ana, bob, vote("cam")));

        assertThat(retry.appended()).isEqualTo(1);
        assertThat(retry.duplicates()).isEqualTo(2);
        assertThat(repository.all()).hasSize(3);
    }

    @Test
    void theSameEventTwiceInOneBatchIsStoredOnce() {
        AuditEvent ana = vote("ana");

        IngestResult result = service.record(List.of(ana, ana));

        assertThat(result.appended()).isEqualTo(1);
        assertThat(result.duplicates()).isEqualTo(1);
    }

    @Test
    void anEmptyBatchStoresNothing() {
        assertThat(service.record(List.of()).appended()).isZero();
        assertThat(repository.all()).isEmpty();
    }

    @Test
    void verificationFindsATamperedRecordAndIsKeptAsTheLastResult() {
        service.record(List.of(vote("ana"), vote("bob"), vote("cam")));
        repository.remove(1);

        ChainVerification result = service.verify();

        assertThat(result.valid()).isFalse();
        assertThat(result.problem()).isEqualTo(Problem.MISSING_RECORD);
        assertThat(service.lastVerification()).contains(result);
    }

    @Test
    void aTailDeletedAfterItWasSeenIsReportedAsTruncated() {
        service.record(List.of(vote("ana"), vote("bob"), vote("cam")));
        assertThat(service.verify().valid()).isTrue();
        repository.remove(2);

        ChainVerification result = service.verify();

        assertThat(result.problem()).isEqualTo(Problem.TRUNCATED);
        assertThat(result.firstBrokenSeq()).isEqualTo(3);
    }

    @Test
    void aBatchCommittedDuringTheWalkIsNotReportedAsTruncated() {
        AtomicReference<AuditService> writer = new AtomicReference<>();
        InMemoryAuditLogRepository busy = new InMemoryAuditLogRepository() {
            @Override
            public synchronized void forEachInOrder(Consumer<AuditRecord> consumer) {
                // The walk reads the records visible when its query started...
                List<AuditRecord> snapshot = all();
                // ...while another producer's batch commits.
                writer.get().record(List.of(vote("dan")));
                snapshot.forEach(consumer);
            }
        };
        AuditService walking = new AuditService(busy, ip -> "unknown", new AuditChain(null),
                Clock.fixed(Instant.parse("2026-11-15T12:00:05Z"), ZoneOffset.UTC));
        writer.set(walking);
        walking.record(List.of(vote("ana"), vote("bob"), vote("cam")));

        ChainVerification during = walking.verify();
        assertThat(during.valid()).isTrue();
        assertThat(during.headSeq()).isEqualTo(3);

        // The next walk sees the new batch and still finds the chain intact.
        ChainVerification after = walking.verify();
        assertThat(after.valid()).isTrue();
        assertThat(after.headSeq()).isEqualTo(4);
    }

    @Test
    void theSummaryWindowIsBetweenOneHourAndAWeek() {
        assertThat(service.summarize(0).windowHours()).isEqualTo(1);
        assertThat(service.summarize(10_000).windowHours()).isEqualTo(AuditService.MAX_SUMMARY_HOURS);
    }
}
