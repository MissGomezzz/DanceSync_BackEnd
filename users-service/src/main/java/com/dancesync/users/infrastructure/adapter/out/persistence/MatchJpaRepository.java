package com.dancesync.users.infrastructure.adapter.out.persistence;

import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface MatchJpaRepository extends JpaRepository<MatchEntity, UUID> {

    /** Locks the match row so concurrent upserts of the same match replace it one after another. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select m from MatchEntity m where m.id = :id")
    Optional<MatchEntity> findForUpdateById(@Param("id") UUID id);

    @EntityGraph(attributePaths = "participants")
    Optional<MatchEntity> findWithParticipantsById(UUID id);

    @EntityGraph(attributePaths = "participants")
    List<MatchEntity> findByRoomCodeOrderByFinishedAtDesc(String roomCode);
}
