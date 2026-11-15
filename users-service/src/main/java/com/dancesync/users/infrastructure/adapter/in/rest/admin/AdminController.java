package com.dancesync.users.infrastructure.adapter.in.rest.admin;

import com.dancesync.users.domain.model.audit.AuditEvent.AuditChannel;
import com.dancesync.users.domain.model.audit.AuditEvent.AuditOutcome;
import com.dancesync.users.domain.model.audit.AuditQuery;
import com.dancesync.users.domain.model.audit.AuditRecord;
import com.dancesync.users.domain.model.audit.AuditSummary;
import com.dancesync.users.domain.model.audit.ChainVerification;
import com.dancesync.users.domain.port.in.ListAdminAlertsUseCase;
import com.dancesync.users.domain.port.in.ListAdminAlertsUseCase.AlertsView;
import com.dancesync.users.domain.port.in.QueryAuditLogUseCase;
import com.dancesync.users.domain.port.in.VerifyAuditChainUseCase;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;

/**
 * The admin screen's API (SEG-2): audit records, their overview, the verification of the chain and
 * the alerts. Routed by the api-gateway only to the admin (ROLE_ADMIN, the single account named by
 * ADMIN_USER_OID); the gateway adds the internal secret checked by
 * {@link com.dancesync.users.infrastructure.audit.InternalTokenFilter}. Every call reaches the
 * audit log itself through the gateway: the admin's reads are audited too.
 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {

    private static final Logger log = LoggerFactory.getLogger(AdminController.class);

    private final QueryAuditLogUseCase auditLog;
    private final VerifyAuditChainUseCase verification;
    private final ListAdminAlertsUseCase alerts;
    private final IntegrityConfig integrity;

    public AdminController(QueryAuditLogUseCase auditLog, VerifyAuditChainUseCase verification,
                           ListAdminAlertsUseCase alerts, IntegrityConfig integrity) {
        this.auditLog = auditLog;
        this.verification = verification;
        this.alerts = alerts;
        this.integrity = integrity;
    }

    /** Reaching this endpoint at all proves the caller is the admin (the gateway checked the role). */
    @GetMapping("/session")
    public SessionResponse session() {
        return new SessionResponse(true);
    }

    @GetMapping("/audit/records")
    public RecordsPage records(
            @RequestParam(required = false) String user,
            @RequestParam(required = false) String action,
            @RequestParam(required = false) List<String> outcome,
            @RequestParam(required = false) String channel,
            @RequestParam(required = false) String ip,
            @RequestParam(required = false) String correlationId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(required = false) Long beforeSeq,
            @RequestParam(defaultValue = "50") int limit) {
        Set<AuditOutcome> outcomes = EnumSet.noneOf(AuditOutcome.class);
        if (outcome != null) {
            for (String value : outcome) {
                for (String part : value.split(",")) {
                    if (!part.isBlank()) outcomes.add(AuditOutcome.fromWire(part));
                }
            }
        }
        AuditQuery query = new AuditQuery(user, action, outcomes,
                channel == null || channel.isBlank() ? null : AuditChannel.fromWire(channel), ip, correlationId, from,
                to, beforeSeq, limit);
        List<AuditRecord> page = auditLog.search(query);
        Long next = page.size() == query.limit() ? page.get(page.size() - 1).seq() : null;
        return new RecordsPage(page.stream().map(AuditRecordResponse::from).toList(), next);
    }

    @GetMapping("/audit/records/{seq}")
    public ResponseEntity<AuditRecordResponse> record(@PathVariable long seq) {
        return auditLog.findBySeq(seq).map(AuditRecordResponse::from).map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @GetMapping("/audit/summary")
    public OverviewResponse summary(@RequestParam(defaultValue = "24") int hours) {
        return new OverviewResponse(auditLog.summarize(hours), verification.lastVerification().orElse(null), integrity);
    }

    /** Walks the whole chain now; the admin sees the first broken record, if any. */
    @PostMapping("/audit/verify")
    public ChainVerification verify() {
        ChainVerification result = verification.verify();
        log.atInfo().addKeyValue("event", "audit.verified_by_admin").addKeyValue("valid", result.valid())
                .addKeyValue("headSeq", result.headSeq()).addKeyValue("firstBrokenSeq", result.firstBrokenSeq())
                .log("Audit chain verified on request");
        return result;
    }

    @GetMapping("/alerts")
    public AlertsView alerts() {
        return alerts.list();
    }

    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail invalidFilter(IllegalArgumentException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Invalid filter: " + e.getMessage());
    }

    public record SessionResponse(boolean admin) {
    }

    /** @param nextBeforeSeq pass it as {@code beforeSeq} for the next (older) page; null on the last page */
    public record RecordsPage(List<AuditRecordResponse> records, Long nextBeforeSeq) {
    }

    public record OverviewResponse(AuditSummary summary, ChainVerification lastVerification, IntegrityConfig integrity) {
    }

    /**
     * @param keyedChain            HMAC chain (AUDIT_CHAIN_KEY) rather than plain SHA-256
     * @param geoipLoaded           a GeoIP database is loaded
     * @param verifyIntervalSeconds how often the chain is verified in the background
     */
    public record IntegrityConfig(boolean keyedChain, boolean geoipLoaded, long verifyIntervalSeconds) {
    }
}
