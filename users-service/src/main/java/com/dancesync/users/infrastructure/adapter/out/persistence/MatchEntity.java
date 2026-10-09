package com.dancesync.users.infrastructure.adapter.out.persistence;

import com.dancesync.users.domain.model.Match;
import com.dancesync.users.domain.model.MatchEndReason;
import jakarta.persistence.CollectionTable;
import jakarta.persistence.Column;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.PostLoad;
import jakarta.persistence.PostPersist;
import jakarta.persistence.Table;
import jakarta.persistence.Transient;
import lombok.AccessLevel;
import lombok.NoArgsConstructor;
import org.springframework.data.domain.Persistable;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Row of {@code matches} plus its participants.
 *
 * <p>Participants are an element collection (a bag): whenever it changes, Hibernate
 * deletes every participant row of the match before inserting the new ones. That is
 * exactly the replace semantics of the upsert and never collides with the
 * (match_id, player_id) primary key, which separate child entities with orphan removal
 * would (Hibernate flushes their inserts before their deletes).
 */
@Entity
@Table(name = "matches")
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class MatchEntity implements Persistable<UUID> {

    @Id
    private UUID id;

    @Column(name = "room_code", nullable = false, length = 16)
    private String roomCode;

    @Column(name = "song_id", length = 64)
    private String songId;

    @Column(name = "song_title", length = 200)
    private String songTitle;

    @Column(name = "started_at", nullable = false)
    private Instant startedAt;

    @Column(name = "finished_at", nullable = false)
    private Instant finishedAt;

    @Column(name = "winner_player_id", length = 64)
    private String winnerPlayerId;

    /** Stored as the wire value ("song-end" / "not-enough-dancers") to satisfy the table's CHECK constraint. */
    @Column(name = "end_reason", nullable = false, length = 32)
    private String endReason;

    @ElementCollection
    @CollectionTable(name = "match_participants", joinColumns = @JoinColumn(name = "match_id", nullable = false))
    private List<MatchParticipantEmbeddable> participants = new ArrayList<>();

    /**
     * The id is assigned by battle-service, so Spring Data cannot tell a new match from
     * its id. Tracking it avoids the extra SELECT that {@code merge} would issue.
     */
    @Transient
    private boolean newEntity;

    /** A match that is not stored yet; fill it with {@link #replaceWith(Match)}. */
    static MatchEntity newMatch(UUID id) {
        MatchEntity entity = new MatchEntity();
        entity.id = id;
        entity.newEntity = true;
        return entity;
    }

    /** Overwrites every column and the participants with the given match. */
    void replaceWith(Match match) {
        if (!id.equals(match.id())) {
            throw new IllegalArgumentException("Cannot replace match " + id + " with match " + match.id());
        }
        roomCode = match.roomCode();
        songId = match.songId();
        songTitle = match.songTitle();
        startedAt = match.startedAt();
        finishedAt = match.finishedAt();
        winnerPlayerId = match.winnerPlayerId();
        endReason = match.endReason().wireValue();
        participants.clear();
        match.participants().forEach(participant -> participants.add(MatchParticipantEmbeddable.fromDomain(participant)));
    }

    Match toDomain() {
        return new Match(id, roomCode, songId, songTitle, startedAt, finishedAt, winnerPlayerId,
                MatchEndReason.fromWireValue(endReason),
                participants.stream().map(MatchParticipantEmbeddable::toDomain).toList());
    }

    @Override
    public UUID getId() {
        return id;
    }

    @Override
    public boolean isNew() {
        return newEntity;
    }

    @PostLoad
    @PostPersist
    void markStored() {
        newEntity = false;
    }
}
