package com.dancesync.users.infrastructure.observability;

import org.junit.jupiter.api.Test;
import org.springframework.boot.micrometer.metrics.test.autoconfigure.AutoConfigureMetrics;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalManagementPort;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * OBS-1: Prometheus metrics on the management port only, with percentile histograms and the
 * {@code service} tag; the API port keeps {@code /actuator/health} and nothing else of the
 * actuator. Skipped when Docker is not available (the context needs PostgreSQL).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
// Tests disable metrics export by default; this one is about the Prometheus endpoint.
@AutoConfigureMetrics
@Testcontainers(disabledWithoutDocker = true)
class ObservabilityEndpointsTest {

    @Container
    @ServiceConnection
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:16-alpine");

    @LocalServerPort
    private int apiPort;

    @LocalManagementPort
    private int managementPort;

    private final HttpClient http = HttpClient.newHttpClient();

    @Test
    void servesPrometheusOnTheManagementPortOnly() throws Exception {
        assertThat(managementPort).isNotEqualTo(apiPort);
        // One request so http.server.requests has samples.
        HttpResponse<String> apiCall = get(apiPort, "/api/matches?roomCode=ABC123", "obs1-users-1");
        assertThat(apiCall.statusCode()).isEqualTo(200);
        assertThat(apiCall.headers().firstValue("X-Correlation-Id")).contains("obs1-users-1");

        HttpResponse<String> metrics = get(managementPort, "/actuator/prometheus", null);
        assertThat(metrics.statusCode()).isEqualTo(200);
        assertThat(metrics.body())
                .contains("http_server_requests_seconds_bucket")
                .contains("service=\"users-service\"")
                .contains("jvm_memory_used_bytes")
                .contains("hikaricp_connections");

        assertThat(get(apiPort, "/actuator/prometheus", null).statusCode()).isEqualTo(404);
    }

    @Test
    void keepsTheHealthCheckOnBothPorts() throws Exception {
        HttpResponse<String> api = get(apiPort, "/actuator/health", null);
        assertThat(api.statusCode()).isEqualTo(200);
        assertThat(api.body()).contains("\"status\":\"UP\"");
        assertThat(get(managementPort, "/actuator/health", null).statusCode()).isEqualTo(200);
    }

    private HttpResponse<String> get(int port, String path, String correlationId) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET();
        if (correlationId != null) request.header("X-Correlation-Id", correlationId);
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }
}
