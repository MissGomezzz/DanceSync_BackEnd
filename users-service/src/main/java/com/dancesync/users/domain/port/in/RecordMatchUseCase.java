package com.dancesync.users.domain.port.in;

import com.dancesync.users.domain.model.Match;

public interface RecordMatchUseCase {

    /**
     * Stores the match, replacing any match already stored with the same id. Recording
     * the same match again is therefore safe, which lets battle-service retry freely.
     */
    Match record(Match match);
}
