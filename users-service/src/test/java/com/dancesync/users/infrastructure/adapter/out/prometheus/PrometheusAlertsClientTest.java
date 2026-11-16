package com.dancesync.users.infrastructure.adapter.out.prometheus;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class PrometheusAlertsClientTest {

    @Test
    void trailingSlashesAreDroppedWithoutTouchingTheRestOfTheUrl() {
        assertThat(PrometheusAlertsClient.withoutTrailingSlashes("http://prometheus:9090///"))
                .isEqualTo("http://prometheus:9090");
        assertThat(PrometheusAlertsClient.withoutTrailingSlashes("http://prometheus:9090/api"))
                .isEqualTo("http://prometheus:9090/api");
        assertThat(PrometheusAlertsClient.withoutTrailingSlashes("///")).isEmpty();
        assertThat(PrometheusAlertsClient.withoutTrailingSlashes("")).isEmpty();
    }

    @Test
    void withoutAPrometheusAddressItIsNotConfiguredAndReportsNoAlerts() {
        PrometheusAlertsClient client = new PrometheusAlertsClient("  ");

        assertThat(client.configured()).isFalse();
        assertThat(client.activeAlerts()).isEqualTo(List.of());
    }

    @Test
    void withAnAddressItIsConfigured() {
        assertThat(new PrometheusAlertsClient("http://prometheus:9090/").configured()).isTrue();
    }
}
