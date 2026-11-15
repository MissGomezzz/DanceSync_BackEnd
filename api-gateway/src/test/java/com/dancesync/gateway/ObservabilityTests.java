package com.dancesync.gateway;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.micrometer.metrics.test.autoconfigure.AutoConfigureMetrics;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.test.web.server.LocalManagementPort;
import org.springframework.boot.test.web.server.LocalServerPort;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * OBS-1: Prometheus metrics on the management port only, JSON access lines with the
 * correlation id, and the refusals counted next to their audit lines.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
// Tests disable metrics export by default; this one is about the Prometheus endpoint.
@AutoConfigureMetrics
@ExtendWith(OutputCaptureExtension.class)
class ObservabilityTests {

    @LocalServerPort
    private int gatewayPort;

    @LocalManagementPort
    private int managementPort;

    private final HttpClient http = HttpClient.newHttpClient();

    @Test
    void servesPrometheusOnTheManagementPortWithTheRefusalsCounted() throws Exception {
        assertNotEquals(gatewayPort, managementPort);
        assertEquals(401, get(gatewayPort, "/api/matches/1", "obs1-gateway-refused").statusCode());

        HttpResponse<String> metrics = get(managementPort, "/actuator/prometheus", null);
        assertEquals(200, metrics.statusCode());
        String body = metrics.body();
        assertTrue(body.contains("gateway_auth_rejected_total{code=\"UNAUTHORIZED\",service=\"api-gateway\"}"), body);
        assertTrue(body.contains("gateway_rate_limited_total{policy=\"guest-token\",service=\"api-gateway\"} 0.0"), body);
        assertTrue(body.contains("http_server_requests_seconds_bucket"), "percentile histograms are on");
        assertTrue(body.contains("jvm_memory_used_bytes"));
    }

    @Test
    void keepsTheActuatorOffThePublicPortExceptTheHealthCheck() throws Exception {
        assertEquals(200, get(gatewayPort, "/actuator/health", null).statusCode());
        assertEquals(200, get(managementPort, "/actuator/health", null).statusCode());
        // Security rules for /actuator/** on the public port are unchanged: a signed-in user is required.
        assertEquals(401, get(gatewayPort, "/actuator/prometheus", null).statusCode());
    }

    @Test
    void writesOneJsonAccessLineWithTheCorrelationId(CapturedOutput output) throws Exception {
        get(gatewayPort, "/api/matches/1?secret=in-the-query", "obs1-gateway-access");

        String line = accessLine(output, "obs1-gateway-access");
        assertTrue(line.startsWith("{") && line.endsWith("}"), line);
        assertTrue(line.contains("\"correlationId\":\"obs1-gateway-access\""), line);
        assertTrue(line.contains("\"method\":\"GET\""), line);
        assertTrue(line.contains("\"path\":\"/api/matches/1\""), line);
        assertTrue(line.contains("\"status\":401"), line);
        assertTrue(line.contains("\"name\":\"api-gateway\""), "service.name: " + line);
        assertTrue(!line.contains("in-the-query"), "the query string was logged");
    }

    /** The access line is written once the response completed, so it may land just after the client got it. */
    private static String accessLine(CapturedOutput output, String correlationId) throws InterruptedException {
        for (int attempt = 0; attempt < 50; attempt++) {
            String found = output.getAll().lines()
                    .filter(l -> l.contains("\"message\":\"HTTP request\"") && l.contains(correlationId))
                    .findFirst()
                    .orElse(null);
            if (found != null) return found;
            Thread.sleep(50);
        }
        throw new AssertionError("no access line in:\n" + output.getAll());
    }

    private HttpResponse<String> get(int port, String path, String correlationId) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET();
        if (correlationId != null) request.header("X-Correlation-Id", correlationId);
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }
}
