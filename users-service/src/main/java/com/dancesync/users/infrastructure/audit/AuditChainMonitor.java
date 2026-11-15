package com.dancesync.users.infrastructure.audit;

import com.dancesync.users.domain.model.audit.ChainVerification;
import com.dancesync.users.domain.port.in.VerifyAuditChainUseCase;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Verifies the whole audit chain in the background (SEG-2) and publishes the result:
 * <ul>
 *   <li>Prometheus: {@code audit_chain_valid} (1 valid, 0 broken, -1 not verified yet),
 *       {@code audit_chain_head_seq} and {@code audit_chain_verified_timestamp_seconds}. The alert
 *       rules fire on a broken chain and on a head that goes back (its tail was deleted).</li>
 *   <li>Logs: one {@code audit.checkpoint} line with the head's sequence number and hash. Those
 *       lines live in the log collector, outside the database, so a chain rebuilt or cut inside the
 *       database no longer matches the checkpoints written before.</li>
 * </ul>
 */
@Component
public class AuditChainMonitor {

    private static final Logger log = LoggerFactory.getLogger(AuditChainMonitor.class);

    private final VerifyAuditChainUseCase verification;

    public AuditChainMonitor(VerifyAuditChainUseCase verification, MeterRegistry registry) {
        this.verification = verification;
        Gauge.builder("audit.chain.valid", verification,
                        v -> v.lastVerification().map(r -> r.valid() ? 1.0 : 0.0).orElse(-1.0))
                .description("1 when the last verification of the audit chain passed, 0 when it found tampering")
                .register(registry);
        Gauge.builder("audit.chain.head.seq", verification,
                        v -> v.lastVerification().map(r -> (double) r.headSeq()).orElse(Double.NaN))
                .description("Sequence number of the last audit record at the last verification")
                .register(registry);
        Gauge.builder("audit.chain.verified.timestamp", verification,
                        v -> v.lastVerification().map(r -> r.verifiedAt().getEpochSecond() * 1.0).orElse(Double.NaN))
                .description("When the audit chain was last verified (epoch seconds)")
                .baseUnit("seconds")
                .register(registry);
    }

    @Scheduled(initialDelayString = "${dancesync.audit.verify-initial-delay:PT20S}",
            fixedDelayString = "${dancesync.audit.verify-interval:PT5M}")
    public void verifyChain() {
        try {
            report(verification.verify());
        } catch (RuntimeException e) {
            log.atError().addKeyValue("error", e.getClass().getSimpleName()).log("Could not verify the audit chain");
        }
    }

    static void report(ChainVerification result) {
        if (result.valid()) {
            log.atInfo()
                    .addKeyValue("event", "audit.checkpoint")
                    .addKeyValue("headSeq", result.headSeq())
                    .addKeyValue("headHash", result.headHash())
                    .addKeyValue("checked", result.checked())
                    .addKeyValue("durationMs", result.durationMs())
                    .log("Audit chain verified");
        } else {
            log.atError()
                    .addKeyValue("event", "audit.chain_broken")
                    .addKeyValue("firstBrokenSeq", result.firstBrokenSeq())
                    .addKeyValue("problem", result.problem())
                    .addKeyValue("headSeq", result.headSeq())
                    .log("Audit chain is broken");
        }
    }
}
