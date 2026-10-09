-- Replaces the unused two-dancer match_history table with a match document
-- that battle-service stores when a battle finishes (HU 21).
-- Player ids are opaque strings (guests today, identity-provider subjects later),
-- so participants have no foreign key to users.

DROP TABLE match_history;

CREATE TABLE matches (
    id               UUID         PRIMARY KEY, -- battle id
    room_code        VARCHAR(16)  NOT NULL,
    song_id          VARCHAR(64),
    song_title       VARCHAR(200),
    started_at       TIMESTAMPTZ  NOT NULL,
    finished_at      TIMESTAMPTZ  NOT NULL,
    winner_player_id VARCHAR(64), -- NULL on a draw or when there is no result
    end_reason       VARCHAR(32)  NOT NULL,
    CONSTRAINT ck_matches_end_reason CHECK (end_reason IN ('song-end', 'not-enough-dancers'))
);

-- Serves "list a room's matches, newest first".
CREATE INDEX idx_matches_room_code_finished_at ON matches (room_code, finished_at DESC);

CREATE TABLE match_participants (
    match_id     UUID        NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
    player_id    VARCHAR(64) NOT NULL,
    display_name VARCHAR(64) NOT NULL,
    role         VARCHAR(16) NOT NULL,
    votes        INT, -- dancer-only columns stay NULL for spectators
    words_won    INT,
    score        INT,
    rank         INT,
    left_early   BOOLEAN     NOT NULL DEFAULT FALSE,
    PRIMARY KEY (match_id, player_id),
    CONSTRAINT ck_match_participants_role CHECK (role IN ('dancer', 'spectator'))
);
