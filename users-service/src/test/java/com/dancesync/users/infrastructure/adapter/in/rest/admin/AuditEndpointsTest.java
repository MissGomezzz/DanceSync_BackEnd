package com.dancesync.users.infrastructure.adapter.in.rest.admin;

import com.dancesync.users.application.service.AdminAlertsService;
import com.dancesync.users.application.service.AuditService;
import com.dancesync.users.domain.port.out.OperationalAlertsPort;
import com.dancesync.users.domain.service.AuditChain;
import com.dancesync.users.infrastructure.audit.AuditProperties;
import com.dancesync.users.infrastructure.audit.InternalTokenFilter;
import com.dancesync.users.support.InMemoryAuditLogRepository;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.is;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * SEG-2: the producers' ingestion and the admin API, with the real service over an in-memory log.
 * Both are refused without the internal secret.
 */
@WebMvcTest({AuditIngestController.class, AdminController.class})
@Import({InternalTokenFilter.class, AuditEndpointsTest.Config.class})
@TestPropertySource(properties = "dancesync.audit.internal-token=" + AuditEndpointsTest.TOKEN)
// Each test starts with an empty log and a writer that has seen nothing.
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_EACH_TEST_METHOD)
class AuditEndpointsTest {

    static final String TOKEN = "an-internal-token-of-at-least-32-bytes";

    @TestConfiguration
    @EnableConfigurationProperties(AuditProperties.class)
    static class Config {
        @Bean
        InMemoryAuditLogRepository repository() {
            return new InMemoryAuditLogRepository();
        }

        @Bean
        Clock clock() {
            return Clock.fixed(Instant.parse("2026-11-15T12:00:02Z"), ZoneOffset.UTC);
        }

        @Bean
        AuditService auditService(InMemoryAuditLogRepository repository, Clock clock) {
            return new AuditService(repository, ip -> "Private network", new AuditChain(null), clock);
        }

        @Bean
        AdminAlertsService alerts(InMemoryAuditLogRepository repository, AuditService service, Clock clock) {
            OperationalAlertsPort none = new OperationalAlertsPort() {
                @Override
                public boolean configured() {
                    return false;
                }

                @Override
                public List<com.dancesync.users.domain.model.audit.AdminAlert> activeAlerts() {
                    return List.of();
                }
            };
            return new AdminAlertsService(repository, service, none, clock,
                    new AdminAlertsService.Thresholds(Duration.ofMinutes(15), 10, Duration.ofHours(1)));
        }

        @Bean
        AdminController.IntegrityConfig integrity() {
            return new AdminController.IntegrityConfig(false, false, 300);
        }

        @Bean
        MeterRegistry meterRegistry() {
            return new SimpleMeterRegistry();
        }
    }

    @Autowired
    private MockMvc mvc;

    @Autowired
    private InMemoryAuditLogRepository repository;

    private static String batch(UUID... ids) {
        StringBuilder events = new StringBuilder();
        for (UUID id : ids) {
            if (!events.isEmpty()) events.append(',');
            events.append("""
                    {"eventId":"%s","occurredAt":"2026-11-15T12:00:00.250Z","source":"battle-service@battle-1",
                     "channel":"socket.io","action":"vote:cast","resource":"ABC123","outcome":"ok",
                     "userId":"oid-ana","userKind":"user","userName":"Ana","ip":"10.0.0.7",
                     "userAgent":"Mozilla/5.0 Chrome/131","correlationId":"corr-1"}""".formatted(id));
        }
        return "{\"events\":[" + events + "]}";
    }

    @Test
    void producersDeliverBatchesThatAreChained() throws Exception {
        mvc.perform(post("/internal/audit/events").header(InternalTokenFilter.HEADER, TOKEN)
                        .contentType(MediaType.APPLICATION_JSON).content(batch(UUID.randomUUID(), UUID.randomUUID())))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.appended", is(2)))
                .andExpect(jsonPath("$.headSeq", is(2)));

        assertThat(repository.all()).hasSize(2);
        assertThat(repository.all().get(0).event().userId()).isEqualTo("oid-ana");
        assertThat(repository.all().get(0).region()).isEqualTo("Private network");
    }

    @Test
    void aBatchWithoutTheSecretIsRefused() throws Exception {
        mvc.perform(post("/internal/audit/events").contentType(MediaType.APPLICATION_JSON).content(batch(UUID.randomUUID())))
                .andExpect(status().isUnauthorized());
        mvc.perform(post("/internal/audit/events").header(InternalTokenFilter.HEADER, "wrong")
                        .contentType(MediaType.APPLICATION_JSON).content(batch(UUID.randomUUID())))
                .andExpect(status().isUnauthorized());

        assertThat(repository.all()).isEmpty();
    }

    @Test
    void anInvalidEventRejectsTheWholeBatch() throws Exception {
        String invalid = batch(UUID.randomUUID()).replace("\"outcome\":\"ok\"", "\"outcome\":\"maybe\"");

        mvc.perform(post("/internal/audit/events").header(InternalTokenFilter.HEADER, TOKEN)
                        .contentType(MediaType.APPLICATION_JSON).content(invalid))
                .andExpect(status().isBadRequest());

        assertThat(repository.all()).isEmpty();
    }

    @Test
    void theAdminApiNeedsTheSecretTheGatewayAdds() throws Exception {
        mvc.perform(get("/api/admin/session")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/admin/audit/records")).andExpect(status().isUnauthorized());

        mvc.perform(get("/api/admin/session").header(InternalTokenFilter.HEADER, TOKEN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.admin", is(true)));
    }

    @Test
    void theAdminPagesThroughRecordsNewestFirst() throws Exception {
        UUID[] ids = new UUID[5];
        for (int i = 0; i < ids.length; i++) ids[i] = UUID.randomUUID();
        mvc.perform(post("/internal/audit/events").header(InternalTokenFilter.HEADER, TOKEN)
                .contentType(MediaType.APPLICATION_JSON).content(batch(ids))).andExpect(status().isAccepted());

        mvc.perform(get("/api/admin/audit/records?limit=3").header(InternalTokenFilter.HEADER, TOKEN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.records", hasSize(3)))
                .andExpect(jsonPath("$.records[0].seq", is(5)))
                .andExpect(jsonPath("$.records[0].userId", is("oid-ana")))
                .andExpect(jsonPath("$.records[0].ip", is("10.0.0.7")))
                .andExpect(jsonPath("$.records[0].region", is("Private network")))
                .andExpect(jsonPath("$.records[0].userAgent", is("Mozilla/5.0 Chrome/131")))
                .andExpect(jsonPath("$.records[0].occurredAt", is("2026-11-15T12:00:00.250Z")))
                .andExpect(jsonPath("$.nextBeforeSeq", is(3)));

        mvc.perform(get("/api/admin/audit/records?limit=3&beforeSeq=3").header(InternalTokenFilter.HEADER, TOKEN))
                .andExpect(jsonPath("$.records", hasSize(2)))
                .andExpect(jsonPath("$.nextBeforeSeq", nullValue()));
    }

    @Test
    void theAdminVerifiesTheChainOnRequest() throws Exception {
        mvc.perform(post("/internal/audit/events").header(InternalTokenFilter.HEADER, TOKEN)
                .contentType(MediaType.APPLICATION_JSON).content(batch(UUID.randomUUID(), UUID.randomUUID())));

        mvc.perform(post("/api/admin/audit/verify").header(InternalTokenFilter.HEADER, TOKEN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.valid", is(true)))
                .andExpect(jsonPath("$.headSeq", is(2)));

        repository.remove(0);
        mvc.perform(post("/api/admin/audit/verify").header(InternalTokenFilter.HEADER, TOKEN))
                .andExpect(jsonPath("$.valid", is(false)))
                .andExpect(jsonPath("$.problem", is("MISSING_RECORD")))
                .andExpect(jsonPath("$.firstBrokenSeq", is(1)));

        mvc.perform(get("/api/admin/alerts").header(InternalTokenFilter.HEADER, TOKEN))
                .andExpect(jsonPath("$.prometheusStatus", is("not_configured")))
                .andExpect(jsonPath("$.security[0].name", is("AuditChainBroken")));
    }

    @Test
    void anUnknownFilterValueIsABadRequest() throws Exception {
        mvc.perform(get("/api/admin/audit/records?outcome=maybe").header(InternalTokenFilter.HEADER, TOKEN))
                .andExpect(status().isBadRequest());
    }

    @Test
    void theSummaryCarriesTheIntegritySettings() throws Exception {
        mvc.perform(get("/api/admin/audit/summary?hours=24").header(InternalTokenFilter.HEADER, TOKEN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.summary.windowHours", is(24)))
                .andExpect(jsonPath("$.integrity.keyedChain", is(false)))
                .andExpect(jsonPath("$.integrity.verifyIntervalSeconds", is(300)));
    }
}
