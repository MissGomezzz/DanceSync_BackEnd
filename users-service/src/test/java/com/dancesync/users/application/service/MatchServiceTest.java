package com.dancesync.users.application.service;

import com.dancesync.users.domain.exception.MatchNotFoundException;
import com.dancesync.users.domain.model.Match;
import com.dancesync.users.support.InMemoryMatchRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static com.dancesync.users.support.MatchFixtures.FINISHED_AT;
import static com.dancesync.users.support.MatchFixtures.dancer;
import static com.dancesync.users.support.MatchFixtures.match;
import static com.dancesync.users.support.MatchFixtures.spectator;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class MatchServiceTest {

    private InMemoryMatchRepository repository;
    private MatchService service;

    @BeforeEach
    void setUp() {
        repository = new InMemoryMatchRepository();
        service = new MatchService(repository);
    }

    @Test
    void recordStoresTheMatch() {
        UUID id = UUID.randomUUID();
        Match stored = service.record(match(id, "ABC123"));

        assertEquals(stored, service.getById(id));
    }

    @Test
    void recordingTheSameMatchAgainReplacesItInsteadOfDuplicating() {
        UUID id = UUID.randomUUID();
        service.record(match(id, "ABC123"));
        Match corrected = match(id, "ABC123", FINISHED_AT, List.of(
                dancer("guest-a", "Ana", 3, 1, 7, 1),
                spectator("guest-c", "Cam")));

        service.record(corrected);
        service.record(corrected);

        assertEquals(1, repository.size());
        assertEquals(corrected, service.getById(id));
        assertEquals(2, service.getById(id).participants().size());
    }

    @Test
    void getByIdThrowsWhenMissing() {
        assertThrows(MatchNotFoundException.class, () -> service.getById(UUID.randomUUID()));
    }

    @Test
    void roomCodesAreCaseInsensitiveOnSaveAndQuery() {
        UUID id = UUID.randomUUID();
        Match stored = service.record(match(id, " abc123 "));

        assertEquals("ABC123", stored.roomCode());
        assertEquals(List.of(stored), service.listByRoomCode("aBc123"));
    }

    @Test
    void listByRoomCodeReturnsNewestFinishFirstAndOnlyThatRoom() {
        Match older = service.record(match(UUID.randomUUID(), "ABC123", FINISHED_AT, List.of()));
        Match newer = service.record(match(UUID.randomUUID(), "ABC123", FINISHED_AT.plusSeconds(600), List.of()));
        service.record(match(UUID.randomUUID(), "ZZZ999"));

        assertEquals(List.of(newer, older), service.listByRoomCode("abc123"));
    }

    @Test
    void listByRoomCodeIsEmptyForAnUnknownRoom() {
        assertEquals(List.of(), service.listByRoomCode("NOPE00"));
    }
}
