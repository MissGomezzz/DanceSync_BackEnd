package com.dancesync.users.infrastructure.adapter.in.rest.dto;

import com.dancesync.users.domain.model.Match;
import com.dancesync.users.domain.model.MatchEndReason;
import com.dancesync.users.domain.model.MatchParticipant;
import com.dancesync.users.domain.model.ParticipantRole;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.Valid;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

/**
 * Match document that battle-service sends with {@code PUT /api/matches/{id}} when a
 * battle finishes. Unknown fields are ignored so battle-service can add fields first.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record RecordMatchRequest(
        @NotBlank @Size(max = 16) String roomCode,
        @Size(max = 64) String songId,
        @Size(max = 200) String songTitle,
        @NotNull Instant startedAt,
        @NotNull Instant finishedAt,
        @Size(max = 64) String winnerPlayerId,
        @NotNull @Pattern(regexp = "song-end|not-enough-dancers") String endReason,
        @NotNull @Size(max = 64) List<@NotNull @Valid Participant> participants) {

    /** A player may appear only once; the store keys participants by (match id, player id). */
    @JsonIgnore
    @AssertTrue(message = "participants must not repeat a playerId")
    public boolean isEachPlayerListedOnce() {
        if (participants == null) {
            return true;
        }
        List<String> playerIds = participants.stream()
                .filter(Objects::nonNull)
                .map(Participant::playerId)
                .filter(Objects::nonNull)
                .toList();
        return playerIds.stream().distinct().count() == playerIds.size();
    }

    public Match toDomain(UUID id) {
        return new Match(id, roomCode, songId, songTitle, startedAt, finishedAt, winnerPlayerId,
                MatchEndReason.fromWireValue(endReason),
                participants.stream().map(Participant::toDomain).toList());
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Participant(
            @NotBlank @Size(max = 64) String playerId,
            @NotBlank @Size(max = 64) String displayName,
            @NotNull @Pattern(regexp = "dancer|spectator") String role,
            @PositiveOrZero Integer votes,
            @PositiveOrZero Integer wordsWon,
            @PositiveOrZero Integer score,
            @Min(1) Integer rank,
            Boolean leftEarly) {

        MatchParticipant toDomain() {
            return new MatchParticipant(playerId, displayName, ParticipantRole.fromWireValue(role),
                    votes, wordsWon, score, rank, Boolean.TRUE.equals(leftEarly));
        }
    }
}
