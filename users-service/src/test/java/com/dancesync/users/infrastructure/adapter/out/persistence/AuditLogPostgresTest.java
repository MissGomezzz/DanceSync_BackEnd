package com.dancesync.users.infrastructure.adapter.out.persistence;

import com.dancesync.users.application.service.AuditService;
import com.dancesync.users.domain.model.audit.AuditEvent;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditOutcome;
import com.dancesync.users.domain.model.audit.AuditQuery;
import com.dancesync.users.domain.model.audit.AuditRecord;
import com.dancesync.users.domain.model.audit.AuditSummary;
import com.dancesync.users.domain.model.audit.ChainVerification;
import com.dancesync.users.domain.model.audit.ChainVerification.Problem;
import com.dancesync.users.domain.port.out.AuditLogRepositoryPort.Offender;
import com.dancesync.users.domain.service.AuditChain;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static com.dancesync.users.support.AuditFixtures.event;
import static com.dancesync.users.support.AuditFixtures.httpRequest;
import static com.dancesync.users.support.AuditFixtures.vote;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * SEG-2 against a real PostgreSQL: the V3 migration, the append-only triggers, concurrent writers
 * keeping one gap-free chain, and the verification finding rows changed or deleted by someone who
 * bypassed the triggers. Skipped when Docker is not available.
 */
@SpringBootTest(properties = "dancesync.audit.verify-initial-delay=PT1H")
@Testcontainers(disabledWithoutDocker = true)
class AuditLogPostgresTest {

    @Container
    @ServiceConnection
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:16-alpine");

    @Autowired
    private AuditLogJdbcAdapter repository;

    @Autowired
    private AuditChain chain;

    /** A fresh writer per test: it remembers the highest record it saw, and each test starts from an empty log. */
    private AuditService service;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private TransactionTemplate transactions;

    /**
     * The table cannot be emptied by design, so each test starts from a fresh one: the triggers
     * are switched off the way a superuser could (session_replication_role), only here.
     */
    @BeforeEach
    void emptyTheLog() {
        transactions.executeWithoutResult(status -> {
            jdbc.execute("SET LOCAL session_replication_role = replica");
            jdbc.execute("DELETE FROM audit_log");
        });
        service = new AuditService(repository, new GeoIpRegionResolverStub(), chain, Clock.systemUTC());
    }

    /** The writer in its own transaction, as the Spring proxy runs it. */
    private void record(List<AuditEvent> events) {
        transactions.executeWithoutResult(status -> service.record(events));
    }

    private ChainVerification verify() {
        return transactions.execute(status -> service.verify());
    }

    private static final class GeoIpRegionResolverStub implements com.dancesync.users.domain.port.out.RegionResolverPort {
        @Override
        public String regionOf(String ip) {
            return "unknown";
        }
    }

    @Test
    void storesEveryFieldAndReadsItBackAsHashed() {
        AuditEvent vote = vote("oid-ana");
        record(List.of(vote));

        AuditRecord stored = repository.findBySeq(1).orElseThrow();
        assertThat(stored.event()).isEqualTo(vote);
        assertThat(stored.region()).isEqualTo("unknown");
        assertThat(verify().valid()).isTrue();
    }

    @Test
    void theDatabaseRefusesUpdatesDeletesAndTruncates() {
        record(List.of(vote("oid-ana")));

        assertThatThrownBy(() -> jdbc.update("UPDATE audit_log SET user_id = 'someone-else' WHERE seq = 1"))
                .isInstanceOf(DataAccessException.class).hasStackTraceContaining("append-only");
        assertThatThrownBy(() -> jdbc.update("DELETE FROM audit_log WHERE seq = 1"))
                .isInstanceOf(DataAccessException.class).hasStackTraceContaining("append-only");
        assertThatThrownBy(() -> jdbc.execute("TRUNCATE audit_log"))
                .isInstanceOf(DataAccessException.class).hasStackTraceContaining("append-only");

        assertThat(repository.findBySeq(1).orElseThrow().event().userId()).isEqualTo("oid-ana");
    }

    @Test
    void concurrentWritersKeepOneGapFreeChain() throws Exception {
        int writers = 8;
        int batchesPerWriter = 10;
        int batchSize = 5;
        ExecutorService pool = Executors.newFixedThreadPool(writers);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<?>> done = new ArrayList<>();
        try {
            for (int w = 0; w < writers; w++) {
                int writer = w;
                done.add(pool.submit((Callable<Void>) () -> {
                    start.await();
                    for (int b = 0; b < batchesPerWriter; b++) {
                        List<AuditEvent> batch = new ArrayList<>();
                        for (int i = 0; i < batchSize; i++) batch.add(vote("writer-" + writer));
                        record(batch);
                    }
                    return null;
                }));
            }
            start.countDown();
            for (Future<?> future : done) future.get();
        } finally {
            pool.shutdownNow();
        }

        int expected = writers * batchesPerWriter * batchSize;
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit_log", Long.class)).isEqualTo(expected);
        assertThat(jdbc.queryForObject("SELECT max(seq) FROM audit_log", Long.class)).isEqualTo(expected);
        ChainVerification result = verify();
        assertThat(result.valid()).isTrue();
        assertThat(result.checked()).isEqualTo(expected);
    }

    @Test
    void aRowChangedBehindTheTriggersIsFound() {
        record(List.of(vote("oid-ana"), vote("oid-bob"), vote("oid-cam")));

        bypassingTheTriggers("UPDATE audit_log SET user_id = 'oid-mallory' WHERE seq = 2");
        ChainVerification result = verify();

        assertThat(result.valid()).isFalse();
        assertThat(result.problem()).isEqualTo(Problem.ALTERED_RECORD);
        assertThat(result.firstBrokenSeq()).isEqualTo(2);
    }

    @Test
    void aTimestampMovedByAMicrosecondIsFound() {
        record(List.of(vote("oid-ana"), vote("oid-bob")));

        bypassingTheTriggers("UPDATE audit_log SET occurred_at = occurred_at + interval '1 microsecond' WHERE seq = 1");

        assertThat(verify().problem()).isEqualTo(Problem.ALTERED_RECORD);
    }

    @Test
    void aRowDeletedBehindTheTriggersIsFound() {
        record(List.of(vote("oid-ana"), vote("oid-bob"), vote("oid-cam")));

        bypassingTheTriggers("DELETE FROM audit_log WHERE seq = 2");
        ChainVerification result = verify();

        assertThat(result.problem()).isEqualTo(Problem.MISSING_RECORD);
        assertThat(result.firstBrokenSeq()).isEqualTo(2);
    }

    @Test
    void searchFiltersAndPagesNewestFirst() {
        record(List.of(
                vote("oid-ana"),
                event("oid-bob", "word:submit", AuditOutcome.FAILED, "198.51.100.2"),
                httpRequest(null, "/api/rooms", 401, AuditOutcome.REJECTED, "198.51.100.9"),
                vote("oid-ana")));

        assertThat(repository.search(query("oid-ana", null, Set.of(), null, null)))
                .extracting(AuditRecord::seq).containsExactly(4L, 1L);
        // Part of the name, case-insensitive.
        assertThat(repository.search(query("an", null, Set.of(), null, null))).hasSize(2);
        assertThat(repository.search(query(null, "WORD", Set.of(), null, null)))
                .extracting(AuditRecord::seq).containsExactly(2L);
        assertThat(repository.search(query(null, null, Set.of(AuditOutcome.REJECTED), null, null)))
                .singleElement().satisfies(r -> {
                    assertThat(r.event().userId()).isNull();
                    assertThat(r.event().status()).isEqualTo(401);
                });
        assertThat(repository.search(query(null, null, Set.of(), "198.51.100.2", null))).hasSize(1);
        assertThat(repository.search(query(null, null, Set.of(), null, 3L)))
                .extracting(AuditRecord::seq).containsExactly(2L, 1L);
        // A % typed in a filter is not a wildcard.
        assertThat(repository.search(query(null, "%", Set.of(), null, null))).isEmpty();
    }

    @Test
    void summarizesTheWindowAndFindsOffenders() {
        List<AuditEvent> events = new ArrayList<>();
        events.add(vote("oid-ana"));
        events.add(vote("oid-bob"));
        for (int i = 0; i < 12; i++) {
            events.add(httpRequest(null, "/api/rooms", 401, AuditOutcome.REJECTED, "198.51.100.9"));
        }
        events.add(event("oid-bot", "chat:message", AuditOutcome.BLOCKED, "198.51.100.66"));
        // Valid tokens refused for lack of rights (users who are not the admin, from one shared address):
        // they are recorded, but they are not a token being guessed.
        for (int i = 0; i < 12; i++) {
            events.add(httpRequest("oid-user-" + i, "/api/admin/session", 403, AuditOutcome.REJECTED, "10.0.0.1"));
        }
        record(events);
        Instant now = Instant.parse("2026-11-15T12:30:00Z");

        AuditSummary summary = repository.summarize(24, now);

        assertThat(summary.total()).isEqualTo(27);
        assertThat(summary.byOutcome()).containsEntry("rejected", 24L).containsEntry("ok", 2L).containsEntry("blocked", 1L);
        assertThat(summary.byChannel()).containsEntry("http", 24L).containsEntry("socket.io", 3L);
        assertThat(summary.distinctUsers()).isEqualTo(15);
        assertThat(summary.topActions()).extracting(c -> c.key()).contains("POST /api/rooms", "POST /api/admin/session");
        assertThat(summary.topIps()).extracting(c -> c.key()).contains("198.51.100.9", "10.0.0.1");
        assertThat(summary.topUsers()).extracting(c -> c.key()).contains("oid-ana", "oid-bot");
        assertThat(summary.timeline()).hasSize(25);
        assertThat(summary.timeline().stream().mapToLong(b -> b.total()).sum()).isEqualTo(27);
        assertThat(summary.timeline().stream().mapToLong(b -> b.incidents()).sum()).isEqualTo(25);
        assertThat(summary.headSeq()).isEqualTo(27);

        // Only the address without valid tokens; the 12 refused admin attempts from 10.0.0.1 do not count.
        List<Offender> bursts = repository.rejectedBursts(Duration.ofHours(1), 10, now);
        assertThat(bursts).singleElement().satisfies(o -> {
            assertThat(o.ip()).isEqualTo("198.51.100.9");
            assertThat(o.count()).isEqualTo(12);
        });
        assertThat(repository.rejectedBursts(Duration.ofHours(1), 13, now)).isEmpty();
        assertThat(repository.blockedClients(Duration.ofHours(1), now))
                .singleElement().satisfies(o -> assertThat(o.userId()).isEqualTo("oid-bot"));
    }

    private void bypassingTheTriggers(String sql) {
        transactions.executeWithoutResult(status -> {
            jdbc.execute("SET LOCAL session_replication_role = replica");
            jdbc.execute(sql);
        });
    }

    private static AuditQuery query(String user, String action, Set<AuditOutcome> outcomes, String ip, Long beforeSeq) {
        return new AuditQuery(user, action, outcomes, null, ip, null, null, null, beforeSeq, 50);
    }
}
