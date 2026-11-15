package com.dancesync.users.infrastructure.adapter.out.persistence;

import com.dancesync.users.domain.model.audit.AuditEvent;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditChannel;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditOutcome;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditUserKind;
import com.dancesync.users.domain.model.audit.AuditQuery;
import com.dancesync.users.domain.model.audit.AuditRecord;
import com.dancesync.users.domain.model.audit.AuditSummary;
import com.dancesync.users.domain.model.audit.AuditSummary.Bucket;
import com.dancesync.users.domain.model.audit.AuditSummary.Count;
import com.dancesync.users.domain.port.out.AuditLogRepositoryPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.namedparam.SqlParameterSource;
import org.springframework.stereotype.Repository;

import javax.sql.DataSource;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;

/**
 * The audit chain in PostgreSQL ({@code audit_log}, V3). Plain JDBC rather than JPA: the table is
 * insert-only, appended in batches under an advisory lock and read with a streaming cursor, none
 * of which needs an entity lifecycle.
 */
@Repository
public class AuditLogJdbcAdapter implements AuditLogRepositoryPort {

    /** Key of the transaction-scoped advisory lock that serializes appends ("SEG2"). */
    static final long APPEND_LOCK_KEY = 0x53454732L;

    /**
     * A refusal for not having a valid token (HTTP 401, Socket.IO UNAUTHORIZED / its reasons), as
     * opposed to a valid token without the right (403: a guest outside its room, a user who is not
     * the admin). Only the first looks like a token being guessed or replayed.
     */
    static final String INVALID_TOKEN = """
            (status = 401 OR (status IS NULL AND code IN ('UNAUTHORIZED', 'missing_token', 'malformed_token',
             'invalid_signature', 'expired_token', 'wrong_issuer', 'wrong_audience', 'invalid_claims',
             'verifier_unavailable')))""";

    private static final String SECURITY_OUTCOMES = "('rejected', 'rate_limited', 'blocked')";
    private static final String COLUMNS = """
            seq, event_id, occurred_at, recorded_at, source, channel, action, resource, outcome, status, code,
            user_id, user_kind, user_name, ip, region, user_agent, correlation_id, detail, prev_hash, hash""";

    private final NamedParameterJdbcTemplate jdbc;
    /** Same connections (and transaction), but rows are fetched 1000 at a time instead of all at once. */
    private final JdbcTemplate streaming;

    public AuditLogJdbcAdapter(DataSource dataSource) {
        this.jdbc = new NamedParameterJdbcTemplate(dataSource);
        this.streaming = new JdbcTemplate(dataSource);
        this.streaming.setFetchSize(1000);
    }

    @Override
    public void lockForAppend() {
        jdbc.getJdbcTemplate().query("SELECT pg_advisory_xact_lock(?)", rs -> null, APPEND_LOCK_KEY);
    }

    @Override
    public Optional<Head> head() {
        return jdbc.getJdbcTemplate()
                .query("SELECT seq, hash, recorded_at FROM audit_log ORDER BY seq DESC LIMIT 1",
                        (rs, i) -> new Head(rs.getLong("seq"), rs.getString("hash"), instant(rs, "recorded_at")))
                .stream().findFirst();
    }

    @Override
    public Set<UUID> existingEventIds(Collection<UUID> eventIds) {
        if (eventIds.isEmpty()) return Set.of();
        return new HashSet<>(jdbc.queryForList("SELECT event_id FROM audit_log WHERE event_id IN (:ids)",
                Map.of("ids", eventIds), UUID.class));
    }

    @Override
    public void appendAll(List<AuditRecord> records) {
        SqlParameterSource[] rows = records.stream().map(AuditLogJdbcAdapter::parameters).toArray(SqlParameterSource[]::new);
        jdbc.batchUpdate("""
                INSERT INTO audit_log (%s) VALUES (
                    :seq, :eventId, :occurredAt, :recordedAt, :source, :channel, :action, :resource, :outcome,
                    :status, :code, :userId, :userKind, :userName, :ip, :region, :userAgent, :correlationId,
                    :detail, :prevHash, :hash)""".formatted(COLUMNS), rows);
    }

    private static SqlParameterSource parameters(AuditRecord record) {
        AuditEvent e = record.event();
        return new MapSqlParameterSource()
                .addValue("seq", record.seq())
                .addValue("eventId", e.eventId())
                .addValue("occurredAt", Timestamp.from(e.occurredAt()))
                .addValue("recordedAt", Timestamp.from(record.recordedAt()))
                .addValue("source", e.source())
                .addValue("channel", e.channel().wire())
                .addValue("action", e.action())
                .addValue("resource", e.resource())
                .addValue("outcome", e.outcome().wire())
                .addValue("status", e.status())
                .addValue("code", e.code())
                .addValue("userId", e.userId())
                .addValue("userKind", e.userKind().wire())
                .addValue("userName", e.userName())
                .addValue("ip", e.ip())
                .addValue("region", record.region())
                .addValue("userAgent", e.userAgent())
                .addValue("correlationId", e.correlationId())
                .addValue("detail", e.detail())
                .addValue("prevHash", record.prevHash())
                .addValue("hash", record.hash());
    }

    @Override
    public void forEachInOrder(Consumer<AuditRecord> consumer) {
        streaming.query("SELECT " + COLUMNS + " FROM audit_log ORDER BY seq",
                rs -> {
                    consumer.accept(RECORD.mapRow(rs, 0));
                });
    }

    @Override
    public List<AuditRecord> search(AuditQuery query) {
        StringBuilder sql = new StringBuilder("SELECT ").append(COLUMNS).append(" FROM audit_log WHERE TRUE");
        MapSqlParameterSource params = new MapSqlParameterSource();
        if (query.user() != null) {
            sql.append(" AND (user_id = :user OR user_name ILIKE :userLike)");
            params.addValue("user", query.user()).addValue("userLike", "%" + escapeLike(query.user()) + "%");
        }
        if (query.action() != null) {
            sql.append(" AND action ILIKE :action");
            params.addValue("action", "%" + escapeLike(query.action()) + "%");
        }
        if (!query.outcomes().isEmpty()) {
            sql.append(" AND outcome IN (:outcomes)");
            params.addValue("outcomes", query.outcomes().stream().map(AuditOutcome::wire).toList());
        }
        if (query.channel() != null) {
            sql.append(" AND channel = :channel");
            params.addValue("channel", query.channel().wire());
        }
        if (query.ip() != null) {
            sql.append(" AND ip = :ip");
            params.addValue("ip", query.ip());
        }
        if (query.correlationId() != null) {
            sql.append(" AND correlation_id = :correlationId");
            params.addValue("correlationId", query.correlationId());
        }
        if (query.from() != null) {
            sql.append(" AND occurred_at >= :from");
            params.addValue("from", Timestamp.from(query.from()));
        }
        if (query.to() != null) {
            sql.append(" AND occurred_at < :to");
            params.addValue("to", Timestamp.from(query.to()));
        }
        if (query.beforeSeq() != null) {
            sql.append(" AND seq < :beforeSeq");
            params.addValue("beforeSeq", query.beforeSeq());
        }
        sql.append(" ORDER BY seq DESC LIMIT :limit");
        params.addValue("limit", query.limit());
        return jdbc.query(sql.toString(), params, RECORD);
    }

    /** {@code %} and {@code _} typed in a filter are matched literally. */
    private static String escapeLike(String value) {
        return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }

    @Override
    public Optional<AuditRecord> findBySeq(long seq) {
        return jdbc.query("SELECT " + COLUMNS + " FROM audit_log WHERE seq = :seq", Map.of("seq", seq), RECORD)
                .stream().findFirst();
    }

    @Override
    public AuditSummary summarize(int windowHours, Instant now) {
        Instant since = now.minus(Duration.ofHours(windowHours));
        MapSqlParameterSource window = new MapSqlParameterSource("since", Timestamp.from(since));
        Map<String, Long> byOutcome = countsBy("outcome", window);
        Map<String, Long> byChannel = countsBy("channel", window);
        long total = byOutcome.values().stream().mapToLong(Long::longValue).sum();
        Map<String, Object> distinct = jdbc.queryForMap("""
                SELECT count(DISTINCT user_id) AS users, count(DISTINCT ip) AS ips
                FROM audit_log WHERE occurred_at >= :since""", window);

        List<Count> topActions = jdbc.query("""
                SELECT action AS key, NULL AS label, count(*) AS n FROM audit_log
                WHERE occurred_at >= :since GROUP BY action ORDER BY n DESC, key LIMIT 8""", window, COUNT);
        List<Count> topUsers = jdbc.query("""
                SELECT user_id AS key, max(user_name) AS label, count(*) AS n FROM audit_log
                WHERE occurred_at >= :since AND user_id IS NOT NULL GROUP BY user_id ORDER BY n DESC, key LIMIT 5""",
                window, COUNT);
        List<Count> topIps = jdbc.query("""
                SELECT ip AS key, max(region) AS label, count(*) AS n FROM audit_log
                WHERE occurred_at >= :since AND outcome IN %s GROUP BY ip ORDER BY n DESC, key LIMIT 5"""
                .formatted(SECURITY_OUTCOMES), window, COUNT);
        List<Count> topRegions = jdbc.query("""
                SELECT region AS key, NULL AS label, count(*) AS n FROM audit_log
                WHERE occurred_at >= :since GROUP BY region ORDER BY n DESC, key LIMIT 5""", window, COUNT);

        Map<Instant, Bucket> buckets = new LinkedHashMap<>();
        Instant firstHour = since.truncatedTo(ChronoUnit.HOURS);
        for (Instant hour = firstHour; !hour.isAfter(now); hour = hour.plus(Duration.ofHours(1))) {
            buckets.put(hour, new Bucket(hour, 0, 0));
        }
        jdbc.query("""
                SELECT date_trunc('hour', occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour,
                       count(*) AS n, count(*) FILTER (WHERE outcome IN %s) AS incidents
                FROM audit_log WHERE occurred_at >= :since GROUP BY 1""".formatted(SECURITY_OUTCOMES), window,
                rs -> {
                    Instant hour = instant(rs, "hour");
                    buckets.put(hour, new Bucket(hour, rs.getLong("n"), rs.getLong("incidents")));
                });

        Optional<Head> head = head();
        return new AuditSummary(windowHours, since, total, byOutcome, byChannel,
                ((Number) distinct.get("users")).longValue(), ((Number) distinct.get("ips")).longValue(),
                topActions, topUsers, topIps, topRegions, new ArrayList<>(buckets.values()),
                head.map(Head::seq).orElse(0L), head.map(Head::recordedAt).orElse(null));
    }

    private Map<String, Long> countsBy(String column, MapSqlParameterSource window) {
        Map<String, Long> counts = new LinkedHashMap<>();
        jdbc.query("SELECT " + column + " AS key, count(*) AS n FROM audit_log WHERE occurred_at >= :since "
                        + "GROUP BY " + column + " ORDER BY n DESC",
                window, rs -> {
                    counts.put(rs.getString("key"), rs.getLong("n"));
                });
        return counts;
    }

    @Override
    public List<Offender> rejectedBursts(Duration window, int threshold, Instant now) {
        return jdbc.query("""
                SELECT ip, max(region) AS region, max(user_id) AS user_id, max(user_name) AS user_name,
                       count(*) AS n, min(occurred_at) AS first_at, max(occurred_at) AS last_at
                FROM audit_log WHERE outcome = 'rejected' AND occurred_at >= :since AND %s
                GROUP BY ip HAVING count(*) >= :threshold ORDER BY n DESC LIMIT 20""".formatted(INVALID_TOKEN),
                new MapSqlParameterSource("since", Timestamp.from(now.minus(window))).addValue("threshold", threshold),
                OFFENDER);
    }

    @Override
    public List<Offender> blockedClients(Duration window, Instant now) {
        return jdbc.query("""
                SELECT ip, max(region) AS region, user_id, max(user_name) AS user_name,
                       count(*) AS n, min(occurred_at) AS first_at, max(occurred_at) AS last_at
                FROM audit_log WHERE outcome = 'blocked' AND occurred_at >= :since
                GROUP BY ip, user_id ORDER BY last_at DESC LIMIT 20""",
                new MapSqlParameterSource("since", Timestamp.from(now.minus(window))), OFFENDER);
    }

    private static final RowMapper<AuditRecord> RECORD = (rs, i) -> {
        AuditEvent event = new AuditEvent(
                rs.getObject("event_id", UUID.class),
                instant(rs, "occurred_at"),
                rs.getString("source"),
                AuditChannel.fromWire(rs.getString("channel")),
                rs.getString("action"),
                rs.getString("resource"),
                AuditOutcome.fromWire(rs.getString("outcome")),
                (Integer) rs.getObject("status"),
                rs.getString("code"),
                rs.getString("user_id"),
                AuditUserKind.fromWire(rs.getString("user_kind")),
                rs.getString("user_name"),
                rs.getString("ip"),
                rs.getString("user_agent"),
                rs.getString("correlation_id"),
                rs.getString("detail"));
        return new AuditRecord(rs.getLong("seq"), event, instant(rs, "recorded_at"), rs.getString("region"),
                rs.getString("prev_hash"), rs.getString("hash"));
    };

    private static final RowMapper<Count> COUNT =
            (rs, i) -> new Count(rs.getString("key"), rs.getString("label"), rs.getLong("n"));

    private static final RowMapper<Offender> OFFENDER = (rs, i) -> new Offender(rs.getString("ip"),
            rs.getString("region"), rs.getString("user_id"), rs.getString("user_name"), rs.getLong("n"),
            instant(rs, "first_at"), instant(rs, "last_at"));

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp value = rs.getTimestamp(column);
        return value == null ? null : value.toInstant();
    }
}
