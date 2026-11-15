-- SEG-2, non-repudiation: append-only audit log of every request to the backend
-- (HTTP through the api-gateway, Socket.IO handshakes and events in battle-service).
--
-- Each row is chained to the previous one: hash = SHA-256 (or HMAC-SHA256 with
-- AUDIT_CHAIN_KEY) of prev_hash plus the canonical form of the row, computed by
-- users-service (AuditChain). Changing, deleting or inserting a row breaks the
-- chain, and the verification names the first broken sequence number.
--
-- seq is assigned by the single writer under an advisory lock, so it has no gaps:
-- a missing number means a deleted row.

CREATE TABLE audit_log (
    seq            BIGINT       PRIMARY KEY,
    event_id       UUID         NOT NULL,     -- set by the producer; makes retried batches idempotent
    occurred_at    TIMESTAMPTZ  NOT NULL,     -- UTC, clock of the server that handled the request
    recorded_at    TIMESTAMPTZ  NOT NULL,     -- UTC, when users-service chained it
    source         VARCHAR(64)  NOT NULL,     -- api-gateway / battle-service, with the replica
    channel        VARCHAR(16)  NOT NULL,     -- http / socket.io
    action         VARCHAR(128) NOT NULL,     -- "POST /api/rooms", "vote:cast", "socket:handshake"...
    resource       VARCHAR(256),              -- request path or room code
    outcome        VARCHAR(16)  NOT NULL,
    status         INT,                       -- HTTP status, when there is one
    code           VARCHAR(64),               -- error code or rejection reason
    user_id        VARCHAR(128),              -- from the validated token; NULL = anonymous
    user_kind      VARCHAR(16)  NOT NULL,     -- user / guest / anonymous
    user_name      VARCHAR(128),
    ip             VARCHAR(64)  NOT NULL,
    region         VARCHAR(128) NOT NULL,     -- GeoIP of ip
    user_agent     VARCHAR(512) NOT NULL,
    correlation_id VARCHAR(64),
    detail         VARCHAR(512),
    prev_hash      CHAR(64)     NOT NULL,
    hash           CHAR(64)     NOT NULL,
    CONSTRAINT uq_audit_log_event_id UNIQUE (event_id),
    CONSTRAINT uq_audit_log_hash UNIQUE (hash),
    CONSTRAINT ck_audit_log_seq CHECK (seq > 0),
    CONSTRAINT ck_audit_log_channel CHECK (channel IN ('http', 'socket.io')),
    CONSTRAINT ck_audit_log_outcome CHECK (outcome IN ('ok', 'failed', 'rejected', 'rate_limited', 'blocked', 'error')),
    CONSTRAINT ck_audit_log_user_kind CHECK (user_kind IN ('user', 'guest', 'anonymous'))
);

-- The admin screen filters by time, user, correlation id, address and outcome, newest first.
CREATE INDEX idx_audit_log_occurred_at ON audit_log (occurred_at DESC);
CREATE INDEX idx_audit_log_user_id ON audit_log (user_id, seq DESC);
CREATE INDEX idx_audit_log_correlation_id ON audit_log (correlation_id);
CREATE INDEX idx_audit_log_ip ON audit_log (ip, seq DESC);
CREATE INDEX idx_audit_log_outcome ON audit_log (outcome, occurred_at DESC);

-- Append-only: rows can be inserted, never changed or removed, not even by the
-- application's own database user. Retention is therefore unlimited (at least
-- the 90 days SEG-2 asks for).
CREATE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_no_update
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TRIGGER trg_audit_log_no_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
