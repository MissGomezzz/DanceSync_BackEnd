package com.dancesync.users.support;

import com.dancesync.users.domain.model.Match;
import com.dancesync.users.domain.port.out.MatchRepositoryPort;

import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** In-memory port implementation with the same replace-by-id semantics as the database adapter. */
public final class InMemoryMatchRepository implements MatchRepositoryPort {

    private final Map<UUID, Match> store = new ConcurrentHashMap<>();

    @Override
    public Match upsert(Match match) {
        store.put(match.id(), match);
        return match;
    }

    @Override
    public Optional<Match> findById(UUID id) {
        return Optional.ofNullable(store.get(id));
    }

    @Override
    public List<Match> findByRoomCode(String roomCode) {
        return store.values().stream()
                .filter(match -> match.roomCode().equals(roomCode))
                .sorted(Comparator.comparing(Match::finishedAt).reversed())
                .toList();
    }

    public int size() {
        return store.size();
    }
}
