package com.dancesync.users.domain.model;

import java.util.Comparator;
import java.util.Objects;

/**
 * One player of a finished match. Votes, words won, score and rank describe a
 * dancer's standing and are absent for spectators.
 */
public record MatchParticipant(
        String playerId,
        String displayName,
        ParticipantRole role,
        Integer votes,
        Integer wordsWon,
        Integer score,
        Integer rank,
        boolean leftEarly) {

    /**
     * Presentation order of a results table: dancers by rank (unranked last) then
     * name, followed by spectators by name. The player id breaks remaining ties so
     * the order is deterministic.
     */
    public static final Comparator<MatchParticipant> RESULTS_ORDER = Comparator
            .comparing(MatchParticipant::role)
            .thenComparing(MatchParticipant::dancerRank, Comparator.nullsLast(Comparator.naturalOrder()))
            .thenComparing(MatchParticipant::displayName)
            .thenComparing(MatchParticipant::playerId);

    public MatchParticipant {
        Objects.requireNonNull(playerId, "playerId must not be null");
        Objects.requireNonNull(displayName, "displayName must not be null");
        Objects.requireNonNull(role, "role must not be null");
    }

    private Integer dancerRank() {
        return role == ParticipantRole.DANCER ? rank : null;
    }
}
