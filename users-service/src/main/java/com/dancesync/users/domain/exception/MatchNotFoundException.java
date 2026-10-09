package com.dancesync.users.domain.exception;

import java.util.UUID;

public class MatchNotFoundException extends RuntimeException {

    public MatchNotFoundException(UUID id) {
        super("Match '" + id + "' was not found");
    }
}
