package com.dancesync.users.domain.port.in;

import com.dancesync.users.domain.model.Match;

import java.util.List;
import java.util.UUID;

public interface GetMatchUseCase {

    /**
     * Returns the match with the given id or throws
     * {@link com.dancesync.users.domain.exception.MatchNotFoundException}.
     */
    Match getById(UUID id);

    /** Returns the matches played in a room, newest finish first. The room code is case-insensitive. */
    List<Match> listByRoomCode(String roomCode);
}
