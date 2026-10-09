package com.dancesync.users.domain.model;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static com.dancesync.users.support.MatchFixtures.FINISHED_AT;
import static com.dancesync.users.support.MatchFixtures.dancer;
import static com.dancesync.users.support.MatchFixtures.match;
import static com.dancesync.users.support.MatchFixtures.spectator;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class MatchTest {

    @Test
    void participantsAreKeptInResultsOrder() {
        MatchParticipant unranked = new MatchParticipant("guest-u", "Uma", ParticipantRole.DANCER,
                0, 0, 0, null, true);
        Match match = match(UUID.randomUUID(), "ABC123", FINISHED_AT, List.of(
                spectator("guest-z", "Zoe"),
                unranked,
                dancer("guest-b", "Bob", 1, 0, 2, 2),
                spectator("guest-c", "Cam"),
                dancer("guest-y", "Yan", 1, 0, 2, 2),
                dancer("guest-a", "Ana", 2, 1, 5, 1)));

        assertEquals(List.of("guest-a", "guest-b", "guest-y", "guest-u", "guest-c", "guest-z"),
                match.participants().stream().map(MatchParticipant::playerId).toList());
    }

    @Test
    void roomCodeIsNormalizedToTrimmedUpperCase() {
        assertEquals("ABC123", match(UUID.randomUUID(), " abc123 ").roomCode());
    }

    @Test
    void aPlayerCannotAppearTwice() {
        List<MatchParticipant> duplicated = List.of(dancer("guest-a", "Ana", 0, 0, 0, 1), spectator("guest-a", "Ana"));

        assertThrows(IllegalArgumentException.class,
                () -> match(UUID.randomUUID(), "ABC123", FINISHED_AT, duplicated));
    }
}
