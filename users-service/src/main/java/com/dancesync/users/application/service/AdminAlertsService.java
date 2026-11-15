package com.dancesync.users.application.service;

import com.dancesync.users.domain.model.audit.AdminAlert;
import com.dancesync.users.domain.model.audit.ChainVerification;
import com.dancesync.users.domain.port.in.ListAdminAlertsUseCase;
import com.dancesync.users.domain.port.in.VerifyAuditChainUseCase;
import com.dancesync.users.domain.port.out.AuditLogRepositoryPort;
import com.dancesync.users.domain.port.out.AuditLogRepositoryPort.Offender;
import com.dancesync.users.domain.port.out.OperationalAlertsPort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Alerts of the admin screen. Operational ones come from Prometheus (OBS-1); security ones are
 * derived here from the audit log (SEG-2, and the SEG-1 / SEG-3 refusals it records):
 * <ul>
 *   <li>RepeatedAuthFailures: one address with at least {@code rejectedThreshold} requests or
 *       connections refused for lacking a valid token (401) within {@code rejectedWindow}. A valid
 *       token refused for lack of rights (403, e.g. a user who is not the admin) does not count;</li>
 *   <li>ClientBlocked: a client blocked for flooding within {@code blockedWindow};</li>
 *   <li>AuditChainBroken: the last verification of the chain found a deleted, inserted or altered record.</li>
 * </ul>
 */
public class AdminAlertsService implements ListAdminAlertsUseCase {

    private static final Logger log = LoggerFactory.getLogger(AdminAlertsService.class);

    private static final Comparator<AdminAlert> MOST_SEVERE_FIRST = Comparator
            .comparingInt((AdminAlert alert) -> switch (alert.severity()) {
                case "critical" -> 0;
                case "warning" -> 1;
                default -> 2;
            })
            .thenComparing(AdminAlert::since, Comparator.nullsLast(Comparator.reverseOrder()));

    private final AuditLogRepositoryPort auditLog;
    private final VerifyAuditChainUseCase verification;
    private final OperationalAlertsPort monitoring;
    private final Clock clock;
    private final Thresholds thresholds;

    public AdminAlertsService(AuditLogRepositoryPort auditLog, VerifyAuditChainUseCase verification,
                              OperationalAlertsPort monitoring, Clock clock, Thresholds thresholds) {
        this.auditLog = auditLog;
        this.verification = verification;
        this.monitoring = monitoring;
        this.clock = clock;
        this.thresholds = thresholds;
    }

    @Override
    @Transactional(readOnly = true)
    public AlertsView list() {
        List<AdminAlert> operational = List.of();
        String status;
        if (!monitoring.configured()) {
            status = "not_configured";
        } else {
            try {
                operational = monitoring.activeAlerts().stream().sorted(MOST_SEVERE_FIRST).toList();
                status = "ok";
            } catch (RuntimeException e) {
                log.atWarn().addKeyValue("error", e.getClass().getSimpleName()).log("Could not read the Prometheus alerts");
                status = "unavailable";
            }
        }
        return new AlertsView(operational, securityAlerts(), status);
    }

    private List<AdminAlert> securityAlerts() {
        Instant now = clock.instant();
        List<AdminAlert> alerts = new ArrayList<>();
        verification.lastVerification().filter(result -> !result.valid()).ifPresent(result -> alerts.add(chainBroken(result)));
        for (Offender offender : auditLog.rejectedBursts(thresholds.rejectedWindow(), thresholds.rejectedThreshold(), now)) {
            alerts.add(new AdminAlert(
                    "audit:auth-failures:" + offender.ip(), "audit", "RepeatedAuthFailures",
                    offender.count() >= thresholds.rejectedThreshold() * 5L ? "critical" : "warning", "firing",
                    offender.count() + " requests without a valid token from " + offender.ip() + " in the last "
                            + minutes(thresholds.rejectedWindow()),
                    "Requests or connections with a missing, expired, tampered or foreign token (SEG-1). "
                            + "A token being guessed or replayed looks like this.",
                    offender.firstAt(), labels(offender)));
        }
        for (Offender offender : auditLog.blockedClients(thresholds.blockedWindow(), now)) {
            String who = offender.userName() != null ? offender.userName() : offender.ip();
            alerts.add(new AdminAlert(
                    "audit:blocked:" + offender.ip() + ":" + offender.userId(), "audit", "ClientBlocked", "warning",
                    "firing",
                    who + " was blocked for flooding (" + offender.count() + " incidents in the last "
                            + minutes(thresholds.blockedWindow()) + ")",
                    "The client sent more events than the token bucket allows and kept going (SEG-3): "
                            + "it was disconnected and blocked for a while.",
                    offender.firstAt(), labels(offender)));
        }
        alerts.sort(MOST_SEVERE_FIRST);
        return alerts;
    }

    private static AdminAlert chainBroken(ChainVerification result) {
        Map<String, String> labels = new LinkedHashMap<>();
        labels.put("firstBrokenSeq", String.valueOf(result.firstBrokenSeq()));
        labels.put("problem", String.valueOf(result.problem()));
        return new AdminAlert("audit:chain", "audit", "AuditChainBroken", "critical", "firing",
                "The audit chain is broken at record #" + result.firstBrokenSeq() + " (" + result.problem() + ")",
                "A record was deleted, inserted or modified after it was written. Records from that point on "
                        + "cannot be trusted until the cause is investigated.",
                result.verifiedAt(), labels);
    }

    private static Map<String, String> labels(Offender offender) {
        Map<String, String> labels = new LinkedHashMap<>();
        labels.put("ip", offender.ip());
        labels.put("region", offender.region());
        if (offender.userId() != null) labels.put("userId", offender.userId());
        if (offender.userName() != null) labels.put("userName", offender.userName());
        labels.put("count", Long.toString(offender.count()));
        labels.put("lastAt", String.valueOf(offender.lastAt()));
        return labels;
    }

    private static String minutes(Duration window) {
        long minutes = Math.max(1, window.toMinutes());
        return minutes + (minutes == 1 ? " minute" : " minutes");
    }

    /** When the audit log raises a security alert. */
    public record Thresholds(Duration rejectedWindow, int rejectedThreshold, Duration blockedWindow) {
    }
}
