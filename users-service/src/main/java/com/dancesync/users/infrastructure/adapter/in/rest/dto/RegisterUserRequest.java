package com.dancesync.users.infrastructure.adapter.in.rest.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record RegisterUserRequest(
        @NotBlank @Size(max = 255) String externalId,
        @NotBlank @Size(max = 100) String displayName,
        @NotBlank @Email @Size(max = 255) String email) {
}
