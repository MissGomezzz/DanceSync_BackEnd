package com.dancesync.users.application.service;

import com.dancesync.users.domain.exception.MatchNotFoundException;
import com.dancesync.users.domain.model.Match;
import com.dancesync.users.domain.port.in.GetMatchUseCase;
import com.dancesync.users.domain.port.in.RecordMatchUseCase;
import com.dancesync.users.domain.port.out.MatchRepositoryPort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Service
public class MatchService implements RecordMatchUseCase, GetMatchUseCase {

    private final MatchRepositoryPort matchRepository;

    public MatchService(MatchRepositoryPort matchRepository) {
        this.matchRepository = matchRepository;
    }

    /**
     * Deliberately not transactional: the repository owns the upsert transaction so it
     * can retry a racing insert in a fresh transaction (a failed one is rollback-only).
     */
    @Override
    public Match record(Match match) {
        return matchRepository.upsert(match);
    }

    @Override
    @Transactional(readOnly = true)
    public Match getById(UUID id) {
        return matchRepository.findById(id).orElseThrow(() -> new MatchNotFoundException(id));
    }

    @Override
    @Transactional(readOnly = true)
    public List<Match> listByRoomCode(String roomCode) {
        return matchRepository.findByRoomCode(Match.normalizeRoomCode(roomCode));
    }
}
