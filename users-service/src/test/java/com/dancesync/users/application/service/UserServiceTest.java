package com.dancesync.users.application.service;

import com.dancesync.users.domain.exception.UserAlreadyExistsException;
import com.dancesync.users.domain.exception.UserNotFoundException;
import com.dancesync.users.domain.model.User;
import com.dancesync.users.domain.port.in.RegisterUserUseCase.RegisterUserCommand;
import com.dancesync.users.domain.port.out.UserRepositoryPort;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class UserServiceTest {

    private InMemoryUserRepository repository;
    private UserService service;

    @BeforeEach
    void setUp() {
        repository = new InMemoryUserRepository();
        service = new UserService(repository);
    }

    @Test
    void registerPersistsNewUser() {
        User user = service.register(new RegisterUserCommand("azure-oid-1", "Alice", "alice@example.com"));

        assertNotNull(user.id());
        assertEquals("azure-oid-1", user.externalId());
        assertEquals(user, service.getById(user.id()));
    }

    @Test
    void registerRejectsDuplicateExternalId() {
        service.register(new RegisterUserCommand("azure-oid-1", "Alice", "alice@example.com"));

        assertThrows(UserAlreadyExistsException.class,
                () -> service.register(new RegisterUserCommand("azure-oid-1", "Alice B", "alice.b@example.com")));
    }

    @Test
    void getByIdThrowsWhenMissing() {
        assertThrows(UserNotFoundException.class, () -> service.getById(UUID.randomUUID()));
    }

    /** Minimal in-memory port implementation; avoids any database or mocking framework. */
    private static final class InMemoryUserRepository implements UserRepositoryPort {

        private final Map<UUID, User> store = new HashMap<>();

        @Override
        public User save(User user) {
            store.put(user.id(), user);
            return user;
        }

        @Override
        public Optional<User> findById(UUID id) {
            return Optional.ofNullable(store.get(id));
        }

        @Override
        public Optional<User> findByExternalId(String externalId) {
            return store.values().stream().filter(u -> u.externalId().equals(externalId)).findFirst();
        }
    }
}
