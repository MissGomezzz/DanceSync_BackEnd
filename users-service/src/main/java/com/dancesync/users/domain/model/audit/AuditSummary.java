package com.dancesync.users.domain.model.audit;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Overview of the audit log over the last {@code windowHours} for the admin screen (SEG-2).
 *
 * @param total          records in the window
 * @param byOutcome      records per outcome (wire names)
 * @param byChannel      records per channel
 * @param distinctUsers  distinct authenticated users (registered and guests)
 * @param distinctIps    distinct client addresses
 * @param topActions     most frequent actions
 * @param topUsers       most active users
 * @param topIps         addresses with the most security incidents (rejected, limited, blocked)
 * @param topRegions     regions with the most requests
 * @param timeline       records per hour, oldest first
 * @param headSeq        last sequence number of the whole log
 * @param lastRecordedAt when the newest record was chained (null for an empty log)
 */
public record AuditSummary(
        int windowHours,
        Instant since,
        long total,
        Map<String, Long> byOutcome,
        Map<String, Long> byChannel,
        long distinctUsers,
        long distinctIps,
        List<Count> topActions,
        List<Count> topUsers,
        List<Count> topIps,
        List<Count> topRegions,
        List<Bucket> timeline,
        long headSeq,
        Instant lastRecordedAt) {

    /** A value and how many records have it; {@code label} adds context (a user's name, an address's region). */
    public record Count(String key, String label, long count) {
    }

    /** One hour of the timeline: all records, and the security incidents among them. */
    public record Bucket(Instant hour, long total, long incidents) {
    }
}
