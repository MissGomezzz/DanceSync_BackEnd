package com.dancesync.users.domain.port.out;

import com.dancesync.users.domain.model.User;

import java.util.Optional;
import java.util.UUID;

public interface UserRepositoryPort {

    User save(User user);

    Optional<User> findById(UUID id);

    Optional<User> findByExternalId(String externalId);
}
