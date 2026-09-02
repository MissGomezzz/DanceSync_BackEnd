package com.dancesync.users.infrastructure.adapter.out.persistence;

import com.dancesync.users.domain.model.User;
import com.dancesync.users.domain.port.out.UserRepositoryPort;
import org.springframework.stereotype.Component;

import java.util.Optional;
import java.util.UUID;

@Component
public class UserPersistenceAdapter implements UserRepositoryPort {

    private final UserJpaRepository jpaRepository;

    public UserPersistenceAdapter(UserJpaRepository jpaRepository) {
        this.jpaRepository = jpaRepository;
    }

    @Override
    public User save(User user) {
        return jpaRepository.save(UserEntity.fromDomain(user)).toDomain();
    }

    @Override
    public Optional<User> findById(UUID id) {
        return jpaRepository.findById(id).map(UserEntity::toDomain);
    }

    @Override
    public Optional<User> findByExternalId(String externalId) {
        return jpaRepository.findByExternalId(externalId).map(UserEntity::toDomain);
    }
}
