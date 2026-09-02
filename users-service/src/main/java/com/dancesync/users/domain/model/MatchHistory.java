package com.dancesync.users.domain.model;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

/**
 * Outcome of a finished dance battle between two users. Persisted so players can
 * review their history. The winner is absent on a draw.
 */
public record MatchHistory(
        UUID id,
        String roomCode,
        UUID dancerOneId,
        UUID dancerTwoId,
        UUID winnerId,
        int dancerOneScore,
        int dancerTwoScore,
        Instant playedAt) {

    public Optional<UUID> winner() {
        return Optional.ofNullable(winnerId);
    }

    public boolean isDraw() {
        return winnerId == null;
    }
}
