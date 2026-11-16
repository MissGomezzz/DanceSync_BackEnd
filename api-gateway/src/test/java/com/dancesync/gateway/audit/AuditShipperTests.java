package com.dancesync.gateway.audit;

import com.sun.net.httpserver.HttpServer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/** SEG-2: the gateway's records survive an outage of users-service and never block a request. */
class AuditShipperTests {

    private static final String TOKEN = "test-internal-token-of-at-least-32-bytes";

    private final List<String> bodies = new CopyOnWriteArrayList<>();
    private final AtomicInteger nextStatus = new AtomicInteger(202);
    private final AtomicLong responseDelayMs = new AtomicLong();
    private final SimpleMeterRegistry registry = new SimpleMeterRegistry();
    private HttpServer server;

    private String startUsersService() throws IOException {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        server.createContext("/internal/audit/events", exchange -> {
            bodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            pause(responseDelayMs.get());
            byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(nextStatus.get(), body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        return "http://localhost:" + server.getAddress().getPort() + "/internal/audit/events";
    }

    private static void pause(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @AfterEach
    void stop() {
        if (server != null) server.stop(0);
    }

    private AuditShipper shipper(String url, int batchSize, int capacity) {
        // A long interval: the tests flush by hand.
        return new AuditShipper(new AuditProperties(true, url, TOKEN, Duration.ofHours(1), batchSize, capacity), registry);
    }

    private static AuditEntry entry(String correlationId) {
        return new AuditEntry(UUID.randomUUID(), Instant.parse("2026-11-15T12:00:00.123Z"), "api-gateway@gw", "http",
                "GET /api/matches", "/api/matches", "ok", 200, null, "user-ana", "user", "Ana \"the\" dancer",
                "203.0.113.7", "Firefox\\133", correlationId, null);
    }

    private double count(String result) {
        return registry.get("gateway.audit.records").tag("result", result).counter().count();
    }

    @Test
    void sendsQueuedRecordsInBatches() throws Exception {
        AuditShipper shipper = shipper(startUsersService(), 2, 100);
        for (int i = 0; i < 5; i++) shipper.submit(entry("c-" + i));

        shipper.flush();

        assertThat(bodies).hasSize(3);
        assertThat(bodies.get(0)).startsWith("{\"events\":[{").contains("\"correlationId\":\"c-0\"")
                .contains("\"correlationId\":\"c-1\"")
                // Quotes and backslashes stay valid JSON.
                .contains("\"userName\":\"Ana \\\"the\\\" dancer\"").contains("\"userAgent\":\"Firefox\\\\133\"");
        assertThat(count("shipped")).isEqualTo(5);
        assertThat(shipper.backlog()).isZero();
    }

    @Test
    void keepsTheBatchWhileUsersServiceIsDownAndDeliversItLater() throws Exception {
        AuditShipper shipper = shipper(startUsersService(), 10, 100);
        nextStatus.set(503);
        shipper.submit(entry("kept"));

        shipper.flush();
        assertThat(shipper.backlog()).isEqualTo(1);
        assertThat(count("shipped")).isZero();

        nextStatus.set(202);
        // Wait out the first back-off (1 s).
        Thread.sleep(1_100);
        shipper.flush();

        assertThat(shipper.backlog()).isZero();
        assertThat(bodies).hasSize(2).allSatisfy(body -> assertThat(body).contains("\"correlationId\":\"kept\""));
        assertThat(count("shipped")).isEqualTo(1);
    }

    @Test
    void anUnreachableUsersServiceKeepsTheRecords() {
        AuditShipper shipper = shipper("http://localhost:1/internal/audit/events", 10, 100);
        shipper.submit(entry("offline"));

        shipper.flush();

        assertThat(shipper.backlog()).isEqualTo(1);
    }

    @Test
    void aBatchRefusedAsInvalidIsDroppedNotRetriedForever() throws Exception {
        AuditShipper shipper = shipper(startUsersService(), 10, 100);
        nextStatus.set(400);
        shipper.submit(entry("invalid"));

        shipper.flush();

        assertThat(shipper.backlog()).isZero();
        assertThat(count("refused")).isEqualTo(1);
    }

    @Test
    void shutdownLetsTheDeliveryInFlightFinishAndSendsWhatIsLeft() throws Exception {
        String url = startUsersService();
        responseDelayMs.set(500);
        // The background worker sends on its own every 50 ms.
        AuditShipper shipper = new AuditShipper(new AuditProperties(true, url, TOKEN, Duration.ofMillis(50), 10, 100), registry);
        shipper.submit(entry("in-flight"));
        long deadline = System.currentTimeMillis() + 5_000;
        while (bodies.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(10);
        assertThat(bodies).as("the worker's delivery reached users-service").hasSize(1);
        shipper.submit(entry("queued"));

        shipper.shutdown();

        assertThat(shipper.backlog()).isZero();
        assertThat(count("shipped")).isEqualTo(2);
        assertThat(String.join("", bodies)).contains("\"correlationId\":\"in-flight\"").contains("\"correlationId\":\"queued\"");
    }

    @Test
    void theLastAttemptOnShutdownIgnoresTheBackOff() throws Exception {
        AuditShipper shipper = shipper(startUsersService(), 10, 100);
        nextStatus.set(503);
        shipper.submit(entry("kept"));
        shipper.flush();
        assertThat(shipper.backlog()).isEqualTo(1);

        nextStatus.set(202);
        shipper.shutdown();

        assertThat(shipper.backlog()).isZero();
        assertThat(count("shipped")).isEqualTo(1);
    }

    @Test
    void aFullBufferDropsNewRecordsInsteadOfBlocking() {
        AuditShipper shipper = shipper("http://localhost:1/internal/audit/events", 10, 3);
        for (int i = 0; i < 5; i++) shipper.submit(entry("c-" + i));

        assertThat(shipper.backlog()).isEqualTo(3);
        assertThat(count("dropped")).isEqualTo(2);
    }

    @Test
    void withoutTheInternalSecretNothingIsSent() throws Exception {
        String url = startUsersService();
        AuditShipper shipper = new AuditShipper(
                new AuditProperties(true, url, "", Duration.ofHours(1), 10, 100), registry);
        shipper.submit(entry("waiting"));

        shipper.flush();

        assertThat(bodies).isEmpty();
        assertThat(shipper.backlog()).isEqualTo(1);
    }

    @Test
    void outcomesFollowTheStatus() {
        assertThat(AuditTrailFilter.outcomeOf(200)).isEqualTo("ok");
        assertThat(AuditTrailFilter.outcomeOf(101)).isEqualTo("ok");
        assertThat(AuditTrailFilter.outcomeOf(401)).isEqualTo("rejected");
        assertThat(AuditTrailFilter.outcomeOf(403)).isEqualTo("rejected");
        assertThat(AuditTrailFilter.outcomeOf(429)).isEqualTo("rate_limited");
        assertThat(AuditTrailFilter.outcomeOf(404)).isEqualTo("failed");
        assertThat(AuditTrailFilter.outcomeOf(502)).isEqualTo("error");
    }
}
