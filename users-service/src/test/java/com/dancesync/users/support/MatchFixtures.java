package com.dancesync.users.support;

import com.dancesync.users.domain.model.Match;
import com.dancesync.users.domain.model.MatchEndReason;
import com.dancesync.users.domain.model.MatchParticipant;
import com.dancesync.users.domain.model.ParticipantRole;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public final class MatchFixtures {

    public static final Instant STARTED_AT = Instant.parse("2026-10-09T12:00:00Z");
    public static final Instant FINISHED_AT = Instant.parse("2026-10-09T12:01:30Z");

    private MatchFixtures() {
    }

    public static MatchParticipant dancer(String playerId, String name, int votes, int wordsWon, int score, int rank) {
        return new MatchParticipant(playerId, name, ParticipantRole.DANCER, votes, wordsWon, score, rank, false);
    }

    public static MatchParticipant spectator(String playerId, String name) {
        return new MatchParticipant(playerId, name, ParticipantRole.SPECTATOR, null, null, null, null, false);
    }

    public static Match match(UUID id, String roomCode, Instant finishedAt, List<MatchParticipant> participants) {
        return new Match(id, roomCode, "song-1", "Some Song", STARTED_AT, finishedAt, "guest-a",
                MatchEndReason.SONG_END, participants);
    }

    public static Match match(UUID id, String roomCode) {
        return match(id, roomCode, FINISHED_AT, List.of(
                dancer("guest-a", "Ana", 2, 1, 5, 1),
                dancer("guest-b", "Bob", 0, 1, 1, 2),
                spectator("guest-c", "Cam")));
    }
}
