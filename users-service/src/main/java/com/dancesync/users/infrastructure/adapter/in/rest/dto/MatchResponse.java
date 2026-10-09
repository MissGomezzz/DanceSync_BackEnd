package com.dancesync.users.infrastructure.adapter.in.rest.dto;

import com.dancesync.users.domain.model.Match;
import com.dancesync.users.domain.model.MatchParticipant;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Stored match; participants come in results order (ranked dancers first, then spectators). */
public record MatchResponse(
        UUID id,
        String roomCode,
        String songId,
        String songTitle,
        Instant startedAt,
        Instant finishedAt,
        String winnerPlayerId,
        String endReason,
        List<Participant> participants) {

    public static MatchResponse from(Match match) {
        return new MatchResponse(match.id(), match.roomCode(), match.songId(), match.songTitle(),
                match.startedAt(), match.finishedAt(), match.winnerPlayerId(), match.endReason().wireValue(),
                match.participants().stream().map(Participant::from).toList());
    }

    public record Participant(
            String playerId,
            String displayName,
            String role,
            Integer votes,
            Integer wordsWon,
            Integer score,
            Integer rank,
            boolean leftEarly) {

        static Participant from(MatchParticipant participant) {
            return new Participant(participant.playerId(), participant.displayName(), participant.role().wireValue(),
                    participant.votes(), participant.wordsWon(), participant.score(), participant.rank(),
                    participant.leftEarly());
        }
    }
}
