package com.dancesync.users.infrastructure.adapter.in.rest.dto;

import com.dancesync.users.domain.model.User;

import java.time.Instant;
import java.util.UUID;

public record UserResponse(UUID id, String externalId, String displayName, String email, Instant createdAt) {

    public static UserResponse from(User user) {
        return new UserResponse(user.id(), user.externalId(), user.displayName(), user.email(), user.createdAt());
    }
}
