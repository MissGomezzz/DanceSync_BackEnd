package com.dancesync.users.domain.service;

import com.dancesync.users.domain.model.audit.AuditEvent;
import com.dancesync.users.domain.model.audit.AuditRecord;
import com.dancesync.users.domain.model.audit.ChainVerification;
import com.dancesync.users.domain.model.audit.ChainVerification.Problem;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static com.dancesync.users.support.AuditFixtures.vote;
import static org.assertj.core.api.Assertions.assertThat;

/** SEG-2: any record altered, deleted, inserted or reordered is found when the chain is verified. */
class AuditChainTest {

    private static final Instant NOW = Instant.parse("2026-11-15T12:00:01.456789Z");

    private final AuditChain chain = new AuditChain(null);

    private List<AuditRecord> chainOf(AuditChain using, int size) {
        List<AuditRecord> records = new ArrayList<>();
        long seq = 0;
        String hash = AuditChain.GENESIS_HASH;
        for (int i = 0; i < size; i++) {
            AuditRecord record = using.append(seq, hash, vote("user-" + i), "Bogotá, Colombia (CO)", NOW);
            records.add(record);
            seq = record.seq();
            hash = record.hash();
        }
        return records;
    }

    private ChainVerification verify(AuditChain using, List<AuditRecord> records, long highestSeen) {
        AuditChain.Walk walk = using.walk();
        records.forEach(walk::accept);
        return walk.finish(highestSeen);
    }

    @Test
    void anUntouchedChainIsValid() {
        List<AuditRecord> records = chainOf(chain, 5);

        ChainVerification result = verify(chain, records, 5);

        assertThat(result.valid()).isTrue();
        assertThat(result.checked()).isEqualTo(5);
        assertThat(result.headSeq()).isEqualTo(5);
        assertThat(result.headHash()).isEqualTo(records.get(4).hash());
        assertThat(records.get(0).prevHash()).isEqualTo(AuditChain.GENESIS_HASH);
        assertThat(records.get(1).prevHash()).isEqualTo(records.get(0).hash());
        // Stored to the millisecond, so the value read back is the one that was hashed.
        assertThat(records.get(0).recordedAt()).isEqualTo(Instant.parse("2026-11-15T12:00:01.456Z"));
    }

    @Test
    void anEmptyLogIsValid() {
        ChainVerification result = verify(chain, List.of(), 0);

        assertThat(result.valid()).isTrue();
        assertThat(result.headSeq()).isZero();
        assertThat(result.headHash()).isEqualTo(AuditChain.GENESIS_HASH);
    }

    @Test
    void aModifiedFieldIsReportedAsAnAlteredRecord() {
        List<AuditRecord> records = chainOf(chain, 5);
        AuditRecord original = records.get(2);
        AuditEvent e = original.event();
        // Someone rewrites who cast the vote, keeping the stored hashes.
        AuditEvent forged = new AuditEvent(e.eventId(), e.occurredAt(), e.source(), e.channel(), e.action(),
                e.resource(), e.outcome(), e.status(), e.code(), "someone-else", e.userKind(), e.userName(), e.ip(),
                e.userAgent(), e.correlationId(), e.detail());
        records.set(2, new AuditRecord(original.seq(), forged, original.recordedAt(), original.region(),
                original.prevHash(), original.hash()));

        ChainVerification result = verify(chain, records, 5);

        assertThat(result.valid()).isFalse();
        assertThat(result.problem()).isEqualTo(Problem.ALTERED_RECORD);
        assertThat(result.firstBrokenSeq()).isEqualTo(3);
    }

    @Test
    void evenATrailingSpaceInAStoredValueIsDetected() {
        List<AuditRecord> records = chainOf(chain, 3);
        AuditRecord original = records.get(0);
        AuditEvent e = original.event();
        AuditEvent padded = new AuditEvent(e.eventId(), e.occurredAt(), e.source(), e.channel(), e.action(),
                e.resource(), e.outcome(), e.status(), e.code(), e.userId(), e.userKind(), e.userName(), e.ip(),
                e.userAgent() + " ", e.correlationId(), e.detail());
        records.set(0, new AuditRecord(1, padded, original.recordedAt(), original.region(), original.prevHash(),
                original.hash()));

        assertThat(verify(chain, records, 3).problem()).isEqualTo(Problem.ALTERED_RECORD);
    }

    @Test
    void aDeletedRecordIsReportedAsMissing() {
        List<AuditRecord> records = chainOf(chain, 5);
        records.remove(1);

        ChainVerification result = verify(chain, records, 5);

        assertThat(result.problem()).isEqualTo(Problem.MISSING_RECORD);
        assertThat(result.firstBrokenSeq()).isEqualTo(2);
    }

    @Test
    void aDeletedFirstRecordIsReportedAsMissing() {
        List<AuditRecord> records = chainOf(chain, 3);
        records.remove(0);

        ChainVerification result = verify(chain, records, 3);

        assertThat(result.problem()).isEqualTo(Problem.MISSING_RECORD);
        assertThat(result.firstBrokenSeq()).isEqualTo(1);
    }

    @Test
    void aRecordInsertedInPlaceOfAnotherBreaksTheLink() {
        List<AuditRecord> records = chainOf(chain, 5);
        // A well-formed record (valid own hash) chained after a made-up predecessor.
        AuditRecord fake = chain.append(2, "f".repeat(64), vote("intruder"), "unknown", NOW);
        records.set(2, fake);

        ChainVerification result = verify(chain, records, 5);

        assertThat(result.problem()).isEqualTo(Problem.BROKEN_LINK);
        assertThat(result.firstBrokenSeq()).isEqualTo(3);
    }

    @Test
    void swappedRecordsAreDetected() {
        List<AuditRecord> records = chainOf(chain, 4);
        AuditRecord second = records.get(1);
        AuditRecord third = records.get(2);
        records.set(1, third);
        records.set(2, second);

        assertThat(verify(chain, records, 4).valid()).isFalse();
    }

    @Test
    void aCutTailIsReportedAsTruncated() {
        List<AuditRecord> records = chainOf(chain, 5);

        ChainVerification result = verify(chain, records.subList(0, 3), 5);

        assertThat(result.problem()).isEqualTo(Problem.TRUNCATED);
        assertThat(result.firstBrokenSeq()).isEqualTo(4);
        assertThat(result.headSeq()).isEqualTo(3);
    }

    @Test
    void aKeyedChainCannotBeRebuiltWithoutTheKey() {
        AuditChain keyed = new AuditChain("a-key-of-at-least-thirty-two-bytes!!".getBytes(StandardCharsets.UTF_8));
        List<AuditRecord> records = chainOf(keyed, 3);

        // Someone with database access but without the key recomputes the chain with SHA-256.
        assertThat(verify(keyed, records, 3).valid()).isTrue();
        assertThat(verify(chain, records, 3).valid()).isFalse();
        assertThat(verify(keyed, chainOf(chain, 3), 3).valid()).isFalse();
    }

    @Test
    void theCanonicalFormCannotShiftAValueIntoItsNeighbour() {
        AuditEvent a = withAction(vote("u"), "vote:cast");
        AuditEvent b = withAction(a, "vote:cas");
        AuditRecord ra = new AuditRecord(1, a, NOW, "x", AuditChain.GENESIS_HASH, AuditChain.GENESIS_HASH);
        AuditRecord rb = new AuditRecord(1, b, NOW, "x", AuditChain.GENESIS_HASH, AuditChain.GENESIS_HASH);

        assertThat(chain.hashOf(ra)).isNotEqualTo(chain.hashOf(rb));
        assertThat(AuditChain.canonical(ra)).contains("9:vote:cast;").contains("-1:;");
    }

    private static AuditEvent withAction(AuditEvent e, String action) {
        return new AuditEvent(UUID.fromString("00000000-0000-4000-8000-000000000001"), e.occurredAt(), e.source(),
                e.channel(), action, e.resource(), e.outcome(), e.status(), e.code(), e.userId(), e.userKind(),
                e.userName(), e.ip(), e.userAgent(), "c", null);
    }
}
