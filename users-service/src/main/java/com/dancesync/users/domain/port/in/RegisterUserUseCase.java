package com.dancesync.users.domain.port.in;

import com.dancesync.users.domain.model.User;

public interface RegisterUserUseCase {

    /**
     * Registers a new user. Fails when a user with the same external id already exists.
     */
    User register(RegisterUserCommand command);

    record RegisterUserCommand(String externalId, String displayName, String email) {
    }
}
