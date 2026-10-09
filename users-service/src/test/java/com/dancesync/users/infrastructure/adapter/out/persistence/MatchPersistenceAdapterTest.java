package com.dancesync.users.infrastructure.adapter.out.persistence;

import com.dancesync.users.domain.model.Match;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.AbstractPlatformTransactionManager;
import org.springframework.transaction.support.DefaultTransactionStatus;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static com.dancesync.users.support.MatchFixtures.FINISHED_AT;
import static com.dancesync.users.support.MatchFixtures.dancer;
import static com.dancesync.users.support.MatchFixtures.match;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Mapping and retry behaviour of the adapter, without a database. */
class MatchPersistenceAdapterTest {

    private MatchJpaRepository jpaRepository;
    private MatchPersistenceAdapter adapter;

    @BeforeEach
    void setUp() {
        jpaRepository = mock(MatchJpaRepository.class);
        adapter = new MatchPersistenceAdapter(jpaRepository, new NoOpTransactionManager());
        when(jpaRepository.saveAndFlush(any(MatchEntity.class))).thenAnswer(call -> call.getArgument(0));
    }

    @Test
    void entityRoundTripKeepsEveryField() {
        Match match = match(UUID.randomUUID(), "ABC123");
        MatchEntity entity = MatchEntity.newMatch(match.id());
        entity.replaceWith(match);

        assertEquals(match, entity.toDomain());
        assertTrue(entity.isNew());
    }

    @Test
    void replacingAStoredMatchReplacesItsParticipants() {
        UUID id = UUID.randomUUID();
        MatchEntity entity = MatchEntity.newMatch(id);
        entity.replaceWith(match(id, "ABC123"));
        Match corrected = match(id, "ABC123", FINISHED_AT, List.of(dancer("guest-a", "Ana", 3, 1, 7, 1)));

        entity.replaceWith(corrected);

        assertEquals(corrected, entity.toDomain());
    }

    @Test
    void upsertInsertsAMatchThatIsNotStoredYet() {
        Match match = match(UUID.randomUUID(), "ABC123");
        when(jpaRepository.findForUpdateById(match.id())).thenReturn(Optional.empty());

        assertEquals(match, adapter.upsert(match));
        verify(jpaRepository, times(1)).saveAndFlush(any(MatchEntity.class));
    }

    @Test
    void upsertUpdatesTheLockedStoredMatch() {
        UUID id = UUID.randomUUID();
        MatchEntity stored = MatchEntity.newMatch(id);
        stored.replaceWith(match(id, "ABC123"));
        stored.markStored();
        when(jpaRepository.findForUpdateById(id)).thenReturn(Optional.of(stored));
        Match corrected = match(id, "ABC123", FINISHED_AT, List.of(dancer("guest-a", "Ana", 3, 1, 7, 1)));

        assertEquals(corrected, adapter.upsert(corrected));
        verify(jpaRepository).saveAndFlush(stored);
        assertFalse(stored.isNew());
    }

    @Test
    void aRacingInsertIsRetriedOnceAsAnUpdate() {
        Match match = match(UUID.randomUUID(), "ABC123");
        MatchEntity winnerRow = MatchEntity.newMatch(match.id());
        winnerRow.replaceWith(match);
        winnerRow.markStored();
        when(jpaRepository.findForUpdateById(match.id()))
                .thenReturn(Optional.empty())
                .thenReturn(Optional.of(winnerRow));
        when(jpaRepository.saveAndFlush(any(MatchEntity.class)))
                .thenThrow(new DataIntegrityViolationException("duplicate key value violates matches_pkey"))
                .thenAnswer(call -> call.getArgument(0));

        assertEquals(match, adapter.upsert(match));
        verify(jpaRepository, times(2)).saveAndFlush(any(MatchEntity.class));
    }

    @Test
    void aSecondFailureIsPropagated() {
        Match match = match(UUID.randomUUID(), "ABC123");
        DataIntegrityViolationException failure = new DataIntegrityViolationException("still failing");
        when(jpaRepository.findForUpdateById(match.id())).thenReturn(Optional.empty());
        when(jpaRepository.saveAndFlush(any(MatchEntity.class))).thenThrow(failure);

        assertSame(failure, assertThrows(DataIntegrityViolationException.class, () -> adapter.upsert(match)));
        verify(jpaRepository, times(2)).saveAndFlush(any(MatchEntity.class));
    }

    /** Lets TransactionTemplate run its callback without a real resource. */
    private static final class NoOpTransactionManager extends AbstractPlatformTransactionManager {

        @Override
        protected Object doGetTransaction() {
            return new Object();
        }

        @Override
        protected void doBegin(Object transaction, TransactionDefinition definition) {
        }

        @Override
        protected void doCommit(DefaultTransactionStatus status) {
        }

        @Override
        protected void doRollback(DefaultTransactionStatus status) {
        }
    }
}
