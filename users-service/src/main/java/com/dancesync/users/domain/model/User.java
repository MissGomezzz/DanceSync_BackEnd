package com.dancesync.users.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * A registered DanceSync user. The external id is the identity-provider subject
 * (Azure Entra ID object id) and is the stable link between the IdP and this service.
 */
public record User(UUID id, String externalId, String displayName, String email, Instant createdAt) {

    public User {
        Objects.requireNonNull(id, "id must not be null");
        Objects.requireNonNull(externalId, "externalId must not be null");
        Objects.requireNonNull(displayName, "displayName must not be null");
        Objects.requireNonNull(email, "email must not be null");
        Objects.requireNonNull(createdAt, "createdAt must not be null");
    }

    public static User register(String externalId, String displayName, String email) {
        return new User(UUID.randomUUID(), externalId, displayName, email, Instant.now());
    }
}
