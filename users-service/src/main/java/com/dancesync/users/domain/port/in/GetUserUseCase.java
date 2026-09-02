package com.dancesync.users.domain.port.in;

import com.dancesync.users.domain.model.User;

import java.util.UUID;

public interface GetUserUseCase {

    /**
     * Returns the user with the given id or throws
     * {@link com.dancesync.users.domain.exception.UserNotFoundException}.
     */
    User getById(UUID id);
}
