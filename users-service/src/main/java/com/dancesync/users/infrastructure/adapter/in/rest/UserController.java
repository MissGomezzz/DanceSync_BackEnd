package com.dancesync.users.infrastructure.adapter.in.rest;

import com.dancesync.users.domain.model.User;
import com.dancesync.users.domain.port.in.GetUserUseCase;
import com.dancesync.users.domain.port.in.RegisterUserUseCase;
import com.dancesync.users.domain.port.in.RegisterUserUseCase.RegisterUserCommand;
import com.dancesync.users.infrastructure.adapter.in.rest.dto.RegisterUserRequest;
import com.dancesync.users.infrastructure.adapter.in.rest.dto.UserResponse;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.net.URI;
import java.util.UUID;

@RestController
@RequestMapping("/api/users")
public class UserController {

    private final RegisterUserUseCase registerUser;
    private final GetUserUseCase getUser;

    public UserController(RegisterUserUseCase registerUser, GetUserUseCase getUser) {
        this.registerUser = registerUser;
        this.getUser = getUser;
    }

    @GetMapping("/{id}")
    public UserResponse getById(@PathVariable UUID id) {
        return UserResponse.from(getUser.getById(id));
    }

    @PostMapping
    public ResponseEntity<UserResponse> register(@Valid @RequestBody RegisterUserRequest request) {
        User user = registerUser.register(
                new RegisterUserCommand(request.externalId(), request.displayName(), request.email()));
        return ResponseEntity
                .created(URI.create("/api/users/" + user.id()))
                .body(UserResponse.from(user));
    }
}
