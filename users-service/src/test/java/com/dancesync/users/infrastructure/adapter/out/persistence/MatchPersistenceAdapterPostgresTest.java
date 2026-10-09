package com.dancesync.users.infrastructure.adapter.out.persistence;

import com.dancesync.users.domain.model.Match;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static com.dancesync.users.support.MatchFixtures.FINISHED_AT;
import static com.dancesync.users.support.MatchFixtures.dancer;
import static com.dancesync.users.support.MatchFixtures.match;
import static com.dancesync.users.support.MatchFixtures.spectator;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Runs the Flyway migrations against a real PostgreSQL (so Hibernate's
 * {@code ddl-auto: validate} checks the entities against V2) and exercises the upsert.
 * Skipped when Docker is not available.
 */
@SpringBootTest
@Testcontainers(disabledWithoutDocker = true)
class MatchPersistenceAdapterPostgresTest {

    @Container
    @ServiceConnection
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:16-alpine");

    @Autowired
    private MatchPersistenceAdapter adapter;

    @Test
    void upsertingTheSameMatchTwiceReplacesItsParticipants() {
        UUID id = UUID.randomUUID();
        adapter.upsert(match(id, "ABC123"));
        Match corrected = match(id, "ABC123", FINISHED_AT, List.of(
                dancer("guest-a", "Ana", 3, 1, 7, 1),
                dancer("guest-b", "Bob", 0, 1, 1, 2),
                spectator("guest-d", "Dee")));

        adapter.upsert(corrected);

        assertEquals(corrected, adapter.findById(id).orElseThrow());
    }

    @Test
    void findByRoomCodeReturnsTheNewestFinishFirst() {
        Match older = adapter.upsert(match(UUID.randomUUID(), "ROOM01", FINISHED_AT, List.of()));
        Match newer = adapter.upsert(match(UUID.randomUUID(), "ROOM01", FINISHED_AT.plusSeconds(60),
                List.of(dancer("guest-a", "Ana", 1, 0, 2, 1), spectator("guest-c", "Cam"))));
        adapter.upsert(match(UUID.randomUUID(), "ROOM02"));

        assertEquals(List.of(newer, older), adapter.findByRoomCode("ROOM01"));
    }

    @Test
    void concurrentFirstUpsertsOfTheSameMatchAllSucceed() throws Exception {
        UUID id = UUID.randomUUID();
        int writers = 8;
        CountDownLatch start = new CountDownLatch(1);
        List<Callable<Match>> calls = new ArrayList<>();
        for (int score = 0; score < writers; score++) {
            Match version = match(id, "RACE01", FINISHED_AT, List.of(
                    dancer("guest-a", "Ana", 1, 0, score, 1), spectator("guest-c", "Cam")));
            calls.add(() -> {
                start.await();
                return adapter.upsert(version);
            });
        }

        ExecutorService pool = Executors.newFixedThreadPool(writers);
        try {
            List<Future<Match>> results = calls.stream().map(pool::submit).toList();
            start.countDown();
            for (Future<Match> result : results) {
                result.get();
            }
        } finally {
            pool.shutdownNow();
        }

        Match stored = adapter.findById(id).orElseThrow();
        assertEquals(2, stored.participants().size());
        assertTrue(stored.participants().get(0).score() < writers);
    }
}
