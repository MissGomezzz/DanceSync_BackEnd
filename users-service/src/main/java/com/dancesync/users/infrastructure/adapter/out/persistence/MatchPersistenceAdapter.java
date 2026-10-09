package com.dancesync.users.infrastructure.adapter.out.persistence;

import com.dancesync.users.domain.model.Match;
import com.dancesync.users.domain.port.out.MatchRepositoryPort;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Component
public class MatchPersistenceAdapter implements MatchRepositoryPort {

    private final MatchJpaRepository jpaRepository;
    private final TransactionTemplate upsertTransaction;

    public MatchPersistenceAdapter(MatchJpaRepository jpaRepository, PlatformTransactionManager transactionManager) {
        this.jpaRepository = jpaRepository;
        this.upsertTransaction = new TransactionTemplate(transactionManager);
        // Each attempt needs its own transaction: a failed one is rollback-only.
        this.upsertTransaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    /**
     * Updates of an existing match are serialized by a row lock. Two first-time upserts
     * of the same id can still both insert; the loser gets a primary-key violation.
     * By then the winner's row exists, so one retry turns the insert into an update.
     * A second failure is not a race and is propagated.
     */
    @Override
    public Match upsert(Match match) {
        try {
            return upsertOnce(match);
        } catch (DataIntegrityViolationException racingInsert) {
            return upsertOnce(match);
        }
    }

    private Match upsertOnce(Match match) {
        return upsertTransaction.execute(status -> {
            MatchEntity entity = jpaRepository.findForUpdateById(match.id())
                    .orElseGet(() -> MatchEntity.newMatch(match.id()));
            entity.replaceWith(match);
            return jpaRepository.saveAndFlush(entity).toDomain();
        });
    }

    @Override
    public Optional<Match> findById(UUID id) {
        return jpaRepository.findWithParticipantsById(id).map(MatchEntity::toDomain);
    }

    @Override
    public List<Match> findByRoomCode(String roomCode) {
        return jpaRepository.findByRoomCodeOrderByFinishedAtDesc(roomCode).stream()
                .map(MatchEntity::toDomain)
                .toList();
    }
}
