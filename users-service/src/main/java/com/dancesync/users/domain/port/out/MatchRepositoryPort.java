package com.dancesync.users.domain.port.out;

import com.dancesync.users.domain.model.Match;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface MatchRepositoryPort {

    /**
     * Inserts the match, or replaces the stored match with the same id (participants
     * included). Implementations must be atomic and safe under concurrent calls for
     * the same id.
     */
    Match upsert(Match match);

    Optional<Match> findById(UUID id);

    /** Expects a normalized room code; returns the newest finish first. */
    List<Match> findByRoomCode(String roomCode);
}
