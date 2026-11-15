package com.dancesync.users.application.service;

import com.dancesync.users.domain.model.audit.AdminAlert;
import com.dancesync.users.domain.model.audit.ChainVerification;
import com.dancesync.users.domain.model.audit.ChainVerification.Problem;
import com.dancesync.users.domain.port.in.ListAdminAlertsUseCase.AlertsView;
import com.dancesync.users.domain.port.in.VerifyAuditChainUseCase;
import com.dancesync.users.domain.port.out.AuditLogRepositoryPort.Offender;
import com.dancesync.users.domain.port.out.OperationalAlertsPort;
import com.dancesync.users.support.InMemoryAuditLogRepository;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

class AdminAlertsServiceTest {

    private static final Instant NOW = Instant.parse("2026-11-15T12:00:00Z");
    private static final AdminAlertsService.Thresholds THRESHOLDS =
            new AdminAlertsService.Thresholds(Duration.ofMinutes(15), 10, Duration.ofHours(1));

    private ChainVerification lastResult;

    private final VerifyAuditChainUseCase verification = new VerifyAuditChainUseCase() {
        @Override
        public ChainVerification verify() {
            return lastResult;
        }

        @Override
        public Optional<ChainVerification> lastVerification() {
            return Optional.ofNullable(lastResult);
        }
    };

    private static OperationalAlertsPort prometheus(boolean configured, List<AdminAlert> alerts, boolean fails) {
        return new OperationalAlertsPort() {
            @Override
            public boolean configured() {
                return configured;
            }

            @Override
            public List<AdminAlert> activeAlerts() {
                if (fails) throw new IllegalStateException("connection refused");
                return alerts;
            }
        };
    }

    private AdminAlertsService service(InMemoryAuditLogRepository repository, OperationalAlertsPort monitoring) {
        return new AdminAlertsService(repository, verification, monitoring, Clock.fixed(NOW, ZoneOffset.UTC), THRESHOLDS);
    }

    @Test
    void withoutPrometheusOnlyTheSecurityAlertsAreShown() {
        AlertsView view = service(new InMemoryAuditLogRepository(), prometheus(false, List.of(), false)).list();

        assertThat(view.prometheusStatus()).isEqualTo("not_configured");
        assertThat(view.operational()).isEmpty();
        assertThat(view.security()).isEmpty();
    }

    @Test
    void anUnreachablePrometheusIsReportedNotFatal() {
        AlertsView view = service(new InMemoryAuditLogRepository(), prometheus(true, List.of(), true)).list();

        assertThat(view.prometheusStatus()).isEqualTo("unavailable");
    }

    @Test
    void operationalAlertsComeMostSevereFirst() {
        AdminAlert warning = new AdminAlert("p:1", "prometheus", "HighHttpLatency", "warning", "firing", "slow", null,
                NOW, Map.of());
        AdminAlert critical = new AdminAlert("p:2", "prometheus", "BattleReplicaDown", "critical", "firing", "down",
                null, NOW.minusSeconds(60), Map.of());

        AlertsView view = service(new InMemoryAuditLogRepository(), prometheus(true, List.of(warning, critical), false))
                .list();

        assertThat(view.prometheusStatus()).isEqualTo("ok");
        assertThat(view.operational()).extracting(AdminAlert::name).containsExactly("BattleReplicaDown", "HighHttpLatency");
    }

    @Test
    void aBrokenChainIsACriticalSecurityAlert() {
        lastResult = new ChainVerification(false, 10, 10, "h", 4L, Problem.ALTERED_RECORD, NOW, 3);

        AlertsView view = service(new InMemoryAuditLogRepository(), prometheus(false, List.of(), false)).list();

        assertThat(view.security()).singleElement().satisfies(alert -> {
            assertThat(alert.name()).isEqualTo("AuditChainBroken");
            assertThat(alert.severity()).isEqualTo("critical");
            assertThat(alert.summary()).contains("#4").contains("ALTERED_RECORD");
        });
    }

    @Test
    void repeatedRejectionsAndBlockedClientsBecomeSecurityAlerts() {
        var offenders = new InMemoryAuditLogRepository() {
            @Override
            public List<Offender> rejectedBursts(Duration window, int threshold, Instant now) {
                return List.of(new Offender("198.51.100.4", "Lima, Peru (PE)", null, null, 60, NOW.minusSeconds(300), NOW));
            }

            @Override
            public List<Offender> blockedClients(Duration window, Instant now) {
                return List.of(new Offender("198.51.100.9", "unknown", "oid-7", "Bot", 3, NOW.minusSeconds(60), NOW));
            }
        };

        AlertsView view = service(offenders, prometheus(false, List.of(), false)).list();

        assertThat(view.security()).extracting(AdminAlert::name).containsExactly("RepeatedAuthFailures", "ClientBlocked");
        AdminAlert burst = view.security().get(0);
        // 60 refusals is more than 5 times the threshold of 10.
        assertThat(burst.severity()).isEqualTo("critical");
        assertThat(burst.summary()).contains("60 requests without a valid token from 198.51.100.4").contains("15 minutes");
        assertThat(burst.labels()).containsEntry("region", "Lima, Peru (PE)");
        assertThat(view.security().get(1).summary()).startsWith("Bot was blocked for flooding");
    }
}
