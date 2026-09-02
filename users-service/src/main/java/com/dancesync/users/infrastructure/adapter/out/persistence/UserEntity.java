package com.dancesync.users.infrastructure.adapter.out.persistence;

import com.dancesync.users.domain.model.User;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "users")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class UserEntity {

    @Id
    private UUID id;

    @Column(name = "external_id", nullable = false, unique = true, length = 255)
    private String externalId;

    @Column(name = "display_name", nullable = false, length = 100)
    private String displayName;

    @Column(name = "email", nullable = false, length = 255)
    private String email;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    private UserEntity(UUID id, String externalId, String displayName, String email, Instant createdAt) {
        this.id = id;
        this.externalId = externalId;
        this.displayName = displayName;
        this.email = email;
        this.createdAt = createdAt;
    }

    static UserEntity fromDomain(User user) {
        return new UserEntity(user.id(), user.externalId(), user.displayName(), user.email(), user.createdAt());
    }

    User toDomain() {
        return new User(id, externalId, displayName, email, createdAt);
    }
}
