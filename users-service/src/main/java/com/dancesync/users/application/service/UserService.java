package com.dancesync.users.application.service;

import com.dancesync.users.domain.exception.UserAlreadyExistsException;
import com.dancesync.users.domain.exception.UserNotFoundException;
import com.dancesync.users.domain.model.User;
import com.dancesync.users.domain.port.in.GetUserUseCase;
import com.dancesync.users.domain.port.in.RegisterUserUseCase;
import com.dancesync.users.domain.port.out.UserRepositoryPort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

@Service
public class UserService implements RegisterUserUseCase, GetUserUseCase {

    private final UserRepositoryPort userRepository;

    public UserService(UserRepositoryPort userRepository) {
        this.userRepository = userRepository;
    }

    @Override
    @Transactional
    public User register(RegisterUserCommand command) {
        userRepository.findByExternalId(command.externalId()).ifPresent(existing -> {
            throw new UserAlreadyExistsException(command.externalId());
        });
        User user = User.register(command.externalId(), command.displayName(), command.email());
        return userRepository.save(user);
    }

    @Override
    @Transactional(readOnly = true)
    public User getById(UUID id) {
        return userRepository.findById(id).orElseThrow(() -> new UserNotFoundException(id));
    }
}
