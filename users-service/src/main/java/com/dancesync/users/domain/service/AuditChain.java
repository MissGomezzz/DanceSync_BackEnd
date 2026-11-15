package com.dancesync.users.domain.service;

import com.dancesync.users.domain.model.audit.AuditEvent;
import com.dancesync.users.domain.model.audit.AuditRecord;
import com.dancesync.users.domain.model.audit.ChainVerification;
import com.dancesync.users.domain.model.audit.ChainVerification.Problem;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;

/**
 * The hash chain of the audit log (SEG-2). Each record's hash covers the previous record's hash
 * and every field of the record itself, so:
 * <ul>
 *   <li>changing any field of a record changes its hash ({@link Problem#ALTERED_RECORD});</li>
 *   <li>deleting, inserting or reordering records breaks the link of the next one
 *       ({@link Problem#BROKEN_LINK}) and leaves a gap in the sequence ({@link Problem#MISSING_RECORD}).</li>
 * </ul>
 *
 * <p>With a key (AUDIT_CHAIN_KEY) the hash is an HMAC-SHA256: whoever can write to the database
 * but does not know the key cannot rebuild a valid chain after tampering with it. Without a key
 * it is a plain SHA-256, which still detects any change made without recomputing the chain.
 *
 * <p>The canonical form writes each field as {@code <length>:<value>;} ({@code -1:;} for null),
 * so no value can be shifted into its neighbour to produce the same bytes.
 */
public final class AuditChain {

    /** prev_hash of the first record. */
    public static final String GENESIS_HASH = "0".repeat(64);

    private static final HexFormat HEX = HexFormat.of();

    private final byte[] key;

    /** @param key HMAC key, or null / empty for plain SHA-256 */
    public AuditChain(byte[] key) {
        this.key = key == null || key.length == 0 ? null : key.clone();
    }

    public boolean keyed() {
        return key != null;
    }

    /** Chains {@code event} after the record whose sequence number and hash are given. */
    public AuditRecord append(long previousSeq, String previousHash, AuditEvent event, String region, Instant recordedAt) {
        String cleanRegion = AuditEvent.optional(region, 128);
        AuditRecord draft = new AuditRecord(previousSeq + 1, event, recordedAt.truncatedTo(ChronoUnit.MILLIS),
                cleanRegion == null ? AuditEvent.UNKNOWN : cleanRegion, previousHash, GENESIS_HASH);
        return new AuditRecord(draft.seq(), event, draft.recordedAt(), draft.region(), previousHash, hashOf(draft));
    }

    /** The hash {@code record} must carry, recomputed from its content and its prev_hash. */
    public String hashOf(AuditRecord record) {
        byte[] content = canonical(record).getBytes(StandardCharsets.UTF_8);
        try {
            if (key != null) {
                Mac mac = Mac.getInstance("HmacSHA256");
                mac.init(new SecretKeySpec(key, "HmacSHA256"));
                return HEX.formatHex(mac.doFinal(content));
            }
            return HEX.formatHex(MessageDigest.getInstance("SHA-256").digest(content));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("SHA-256 / HmacSHA256 must be available in every JVM", e);
        }
    }

    static String canonical(AuditRecord record) {
        AuditEvent e = record.event();
        StringBuilder out = new StringBuilder(512);
        field(out, "v1");
        field(out, Long.toString(record.seq()));
        field(out, record.prevHash());
        field(out, e.eventId().toString());
        field(out, e.occurredAt().toString());
        field(out, record.recordedAt().toString());
        field(out, e.source());
        field(out, e.channel().wire());
        field(out, e.action());
        field(out, e.resource());
        field(out, e.outcome().wire());
        field(out, e.status() == null ? null : e.status().toString());
        field(out, e.code());
        field(out, e.userId());
        field(out, e.userKind().wire());
        field(out, e.userName());
        field(out, e.ip());
        field(out, record.region());
        field(out, e.userAgent());
        field(out, e.correlationId());
        field(out, e.detail());
        return out.toString();
    }

    private static void field(StringBuilder out, String value) {
        if (value == null) {
            out.append("-1:;");
        } else {
            out.append(value.length()).append(':').append(value).append(';');
        }
    }

    /** Starts a walk over the records in ascending sequence order. */
    public Walk walk() {
        return new Walk();
    }

    /**
     * Checks records one by one, in ascending sequence order, without keeping them in memory
     * (the log can hold millions). Stops recording problems after the first one: that is the
     * record an investigation starts from.
     */
    public final class Walk {
        private final long startedAt = System.nanoTime();
        private long expectedSeq = 1;
        private String previousHash = GENESIS_HASH;
        private long checked;
        private Long firstBrokenSeq;
        private Problem problem;

        public void accept(AuditRecord record) {
            checked++;
            if (problem == null) {
                if (record.seq() != expectedSeq) {
                    fail(expectedSeq, Problem.MISSING_RECORD);
                } else if (!record.prevHash().equals(previousHash)) {
                    fail(record.seq(), Problem.BROKEN_LINK);
                } else if (!MessageDigest.isEqual(
                        hashOf(record).getBytes(StandardCharsets.US_ASCII),
                        record.hash().getBytes(StandardCharsets.US_ASCII))) {
                    fail(record.seq(), Problem.ALTERED_RECORD);
                }
            }
            expectedSeq = record.seq() + 1;
            previousHash = record.hash();
        }

        private void fail(long seq, Problem found) {
            firstBrokenSeq = seq;
            problem = found;
        }

        /**
         * @param highestSeenSeq the highest sequence number known to have existed (0 if none):
         *                       a log that now ends before it lost its tail
         */
        public ChainVerification finish(long highestSeenSeq) {
            long headSeq = expectedSeq - 1;
            if (problem == null && headSeq < highestSeenSeq) fail(headSeq + 1, Problem.TRUNCATED);
            long durationMs = (System.nanoTime() - startedAt) / 1_000_000;
            return new ChainVerification(problem == null, checked, headSeq, previousHash, firstBrokenSeq, problem,
                    Instant.now(), durationMs);
        }
    }
}
