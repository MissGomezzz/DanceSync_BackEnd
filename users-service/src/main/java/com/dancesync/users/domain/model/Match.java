package com.dancesync.users.domain.model;

import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * Final results of one battle, stored by battle-service when the battle finishes.
 * The id is the battle id, which makes storing the same battle twice a replacement
 * instead of a duplicate. The winner is absent on a draw or when nobody could win.
 *
 * <p>The room code is kept upper case and the participants are kept in results order
 * (see {@link MatchParticipant#RESULTS_ORDER}), so every copy of a match compares equal
 * regardless of how it was submitted.
 */
public record Match(
        UUID id,
        String roomCode,
        String songId,
        String songTitle,
        Instant startedAt,
        Instant finishedAt,
        String winnerPlayerId,
        MatchEndReason endReason,
        List<MatchParticipant> participants) {

    public Match {
        Objects.requireNonNull(id, "id must not be null");
        Objects.requireNonNull(roomCode, "roomCode must not be null");
        Objects.requireNonNull(startedAt, "startedAt must not be null");
        Objects.requireNonNull(finishedAt, "finishedAt must not be null");
        Objects.requireNonNull(endReason, "endReason must not be null");
        Objects.requireNonNull(participants, "participants must not be null");
        roomCode = normalizeRoomCode(roomCode);
        participants = participants.stream().sorted(MatchParticipant.RESULTS_ORDER).toList();
        requireUniquePlayers(participants);
    }

    /** Room codes are case-insensitive; the canonical form is trimmed upper case. */
    public static String normalizeRoomCode(String roomCode) {
        return roomCode.trim().toUpperCase(Locale.ROOT);
    }

    private static void requireUniquePlayers(List<MatchParticipant> participants) {
        Set<String> seen = new HashSet<>();
        for (MatchParticipant participant : participants) {
            if (!seen.add(participant.playerId())) {
                throw new IllegalArgumentException(
                        "Player '" + participant.playerId() + "' appears more than once in the match");
            }
        }
    }
}
