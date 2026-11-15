package com.dancesync.users.domain.model.audit;

import java.time.Instant;

/**
 * Result of walking the whole audit chain (SEG-2).
 *
 * @param valid          every record is where it should be and unchanged
 * @param checked        records walked
 * @param headSeq        last sequence number (0 for an empty log)
 * @param headHash       hash of the last record (the genesis hash for an empty log)
 * @param firstBrokenSeq first record that fails, or null
 * @param problem        why it fails, or null
 * @param verifiedAt     when the walk finished
 * @param durationMs     how long it took
 */
public record ChainVerification(
        boolean valid,
        long checked,
        long headSeq,
        String headHash,
        Long firstBrokenSeq,
        Problem problem,
        Instant verifiedAt,
        long durationMs) {

    /** What the walk found at {@code firstBrokenSeq}. */
    public enum Problem {
        /** A sequence number is missing: a record was deleted. */
        MISSING_RECORD,
        /** The record does not point to the hash of the one before it: deleted, inserted or reordered. */
        BROKEN_LINK,
        /** The record's content no longer matches its hash: it was modified. */
        ALTERED_RECORD,
        /** The log ends before a record this instance already saw: its tail was deleted. */
        TRUNCATED
    }
}
