-- Initial schema for users-service.

CREATE TABLE users (
    id           UUID         PRIMARY KEY,
    external_id  VARCHAR(255) NOT NULL UNIQUE, -- Azure Entra ID object id
    display_name VARCHAR(100) NOT NULL,
    email        VARCHAR(255) NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE match_history (
    id               UUID         PRIMARY KEY,
    room_code        VARCHAR(16)  NOT NULL,
    dancer_one_id    UUID         NOT NULL REFERENCES users (id),
    dancer_two_id    UUID         NOT NULL REFERENCES users (id),
    winner_id        UUID         REFERENCES users (id),
    dancer_one_score INT          NOT NULL DEFAULT 0,
    dancer_two_score INT          NOT NULL DEFAULT 0,
    played_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_match_history_dancer_one ON match_history (dancer_one_id);
CREATE INDEX idx_match_history_dancer_two ON match_history (dancer_two_id);
