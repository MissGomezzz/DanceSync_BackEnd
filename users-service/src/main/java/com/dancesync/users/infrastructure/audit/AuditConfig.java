package com.dancesync.users.infrastructure.audit;

import com.dancesync.users.application.service.AdminAlertsService;
import com.dancesync.users.application.service.AuditService;
import com.dancesync.users.domain.port.out.AuditLogRepositoryPort;
import com.dancesync.users.domain.port.out.OperationalAlertsPort;
import com.dancesync.users.domain.port.out.RegionResolverPort;
import com.dancesync.users.domain.service.AuditChain;
import com.dancesync.users.infrastructure.adapter.in.rest.admin.AdminController;
import com.dancesync.users.infrastructure.adapter.out.geoip.GeoIpRegionResolver;
import com.dancesync.users.infrastructure.adapter.out.prometheus.PrometheusAlertsClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

import java.time.Clock;

/** Wiring of the audit log (SEG-2): the chain, its writer, the GeoIP lookup and the alerts. */
@Configuration
@EnableScheduling
@EnableConfigurationProperties(AuditProperties.class)
public class AuditConfig {

    private static final Logger log = LoggerFactory.getLogger(AuditConfig.class);

    @Bean
    @ConditionalOnMissingBean
    Clock clock() {
        return Clock.systemUTC();
    }

    @Bean
    AuditChain auditChain(AuditProperties properties) {
        if (properties.chainKey().isEmpty()) {
            log.warn("AUDIT_CHAIN_KEY is not set: the audit chain uses plain SHA-256, which detects tampering "
                    + "but not a chain rebuilt by someone with write access to the database");
        }
        if (!properties.internalCallsEnabled()) {
            log.warn("AUDIT_INTERNAL_TOKEN is not set: audit batches and admin requests will be refused");
        }
        return new AuditChain(properties.chainKeyBytes());
    }

    @Bean(destroyMethod = "close")
    GeoIpRegionResolver regionResolver(AuditProperties properties) {
        return GeoIpRegionResolver.open(properties.geoipDbPath());
    }

    @Bean
    PrometheusAlertsClient operationalAlerts(AuditProperties properties) {
        return new PrometheusAlertsClient(properties.prometheusUrl());
    }

    /** How the chain is protected, shown on the admin screen. */
    @Bean
    AdminController.IntegrityConfig integrityConfig(AuditChain chain, GeoIpRegionResolver regions,
                                                    AuditProperties properties) {
        return new AdminController.IntegrityConfig(chain.keyed(), regions.databaseLoaded(),
                properties.verifyInterval().toSeconds());
    }

    @Bean
    AuditService auditService(AuditLogRepositoryPort repository, RegionResolverPort regions, AuditChain chain,
                              Clock clock) {
        return new AuditService(repository, regions, chain, clock);
    }

    @Bean
    AdminAlertsService adminAlertsService(AuditLogRepositoryPort repository, AuditService verification,
                                          OperationalAlertsPort monitoring, Clock clock, AuditProperties properties) {
        AuditProperties.Alerts alerts = properties.alerts();
        return new AdminAlertsService(repository, verification, monitoring, clock,
                new AdminAlertsService.Thresholds(alerts.rejectedWindow(), alerts.rejectedThreshold(),
                        alerts.blockedWindow()));
    }
}
