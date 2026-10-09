package com.dancesync.users.infrastructure.adapter.out.persistence;

import com.dancesync.users.domain.model.MatchParticipant;
import com.dancesync.users.domain.model.ParticipantRole;
import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import lombok.AccessLevel;
import lombok.NoArgsConstructor;

/** Row of {@code match_participants}; owned by {@link MatchEntity} as an element collection. */
@Embeddable
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class MatchParticipantEmbeddable {

    @Column(name = "player_id", nullable = false, length = 64)
    private String playerId;

    @Column(name = "display_name", nullable = false, length = 64)
    private String displayName;

    /** Stored as the wire value ("dancer" / "spectator") to satisfy the table's CHECK constraint. */
    @Column(name = "role", nullable = false, length = 16)
    private String role;

    @Column(name = "votes")
    private Integer votes;

    @Column(name = "words_won")
    private Integer wordsWon;

    @Column(name = "score")
    private Integer score;

    @Column(name = "rank")
    private Integer rank;

    @Column(name = "left_early", nullable = false)
    private boolean leftEarly;

    static MatchParticipantEmbeddable fromDomain(MatchParticipant participant) {
        MatchParticipantEmbeddable row = new MatchParticipantEmbeddable();
        row.playerId = participant.playerId();
        row.displayName = participant.displayName();
        row.role = participant.role().wireValue();
        row.votes = participant.votes();
        row.wordsWon = participant.wordsWon();
        row.score = participant.score();
        row.rank = participant.rank();
        row.leftEarly = participant.leftEarly();
        return row;
    }

    MatchParticipant toDomain() {
        return new MatchParticipant(playerId, displayName, ParticipantRole.fromWireValue(role),
                votes, wordsWon, score, rank, leftEarly);
    }
}
