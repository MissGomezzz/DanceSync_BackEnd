package com.dancesync.gateway;

import com.dancesync.gateway.support.FakeEntra;
import com.dancesync.gateway.support.UpstreamStub;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SEG-3 (protection against abuse and denial of service) at the API gateway,
 * over real HTTP. The limits are made small so a few requests exhaust them:
 * a burst of 3 that refills one token every 10 s. The gateway trusts one proxy
 * hop, so each test sends {@code X-Forwarded-For} as a load balancer would and
 * uses its own client addresses: the buckets of one test never affect another.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "dancesync.rate-limit.enabled=true",
        "dancesync.rate-limit.trusted-proxy-hops=1",
        "dancesync.rate-limit.room-create.per-second=0.1",
        "dancesync.rate-limit.room-create.burst=3",
        "dancesync.rate-limit.guest-token.per-second=0.1",
        "dancesync.rate-limit.guest-token.burst=3",
        "dancesync.rate-limit.socket-handshake.per-second=0.1",
        "dancesync.rate-limit.socket-handshake.burst=3",
        "dancesync.rate-limit.socket-polling.per-second=0.1",
        "dancesync.rate-limit.socket-polling.burst=3",
        "dancesync.rate-limit.other.per-second=0.1",
        "dancesync.rate-limit.other.burst=3"})
@ExtendWith(OutputCaptureExtension.class)
class Seg3RateLimitTests {

    private static final FakeEntra ENTRA = new FakeEntra();
    private static final UpstreamStub USERS_SERVICE = new UpstreamStub();
    private static final UpstreamStub BATTLE_SERVICE = new UpstreamStub();
    private static final String ORIGIN = "http://localhost:5173";

    private final HttpClient client = HttpClient.newHttpClient();

    @Value("${local.server.port}")
    private int gatewayPort;

    @DynamicPropertySource
    static void configure(DynamicPropertyRegistry registry) {
        registry.add("USERS_SERVICE_URL", USERS_SERVICE::url);
        registry.add("BATTLE_SERVICE_URL", BATTLE_SERVICE::url);
        registry.add("AZURE_TENANT_ID", () -> FakeEntra.TENANT_ID);
        registry.add("AZURE_CLIENT_ID", () -> FakeEntra.CLIENT_ID);
        registry.add("ENTRA_JWKS_URI", ENTRA::jwkSetUri);
        registry.add("GUEST_TOKEN_SECRET", () -> FakeEntra.GUEST_SECRET);
    }

    @AfterAll
    static void stopStubs() {
        USERS_SERVICE.stop();
        BATTLE_SERVICE.stop();
        ENTRA.stop();
    }

    @Test
    @DisplayName("Guest tokens: the burst goes through, the next request is answered 429 and never forwarded")
    void guestTokenFloodIsRefused(CapturedOutput output) throws Exception {
        String path = "/api/rooms/RL1ABC/guest-token";
        for (int i = 0; i < 3; i++) assertEquals(200, send("POST", path, "198.51.100.11", null).statusCode());
        long forwarded = forwardedTo(BATTLE_SERVICE, "POST " + path);

        HttpResponse<String> refused = send("POST", path, "198.51.100.11", "seg3-guest-flood");
        assertEquals(429, refused.statusCode());
        assertEquals(forwarded, forwardedTo(BATTLE_SERVICE, "POST " + path), "a refused request reaches no service");
        long retryAfter = Long.parseLong(refused.headers().firstValue("Retry-After").orElse("0"));
        assertTrue(retryAfter >= 1 && retryAfter <= 10, "Retry-After " + retryAfter);
        assertTrue(refused.body().contains("\"code\":\"RATE_LIMITED\""), refused.body());
        assertTrue(refused.body().contains("\"correlationId\":\"seg3-guest-flood\""), refused.body());
        assertEquals("seg3-guest-flood", refused.headers().firstValue("X-Correlation-Id").orElse(null));
        // CORS headers are on the refusal, so the browser lets the frontend read it.
        assertEquals(ORIGIN, refused.headers().firstValue("Access-Control-Allow-Origin").orElse(null));

        assertTrue(output.getAll().contains("\"event\":\"abuse.rate_limited\",\"channel\":\"http\",\"policy\":\"guest-token\","
                + "\"ip\":\"198.51.100.11\""), "the incident is in the audit log");
    }

    @Test
    @DisplayName("Each client address has its own bucket")
    void addressesAreLimitedSeparately() throws Exception {
        String path = "/api/rooms/RL2ABC/guest-token";
        for (int i = 0; i < 3; i++) send("POST", path, "198.51.100.21", null);
        assertEquals(429, send("POST", path, "198.51.100.21", null).statusCode());
        assertEquals(200, send("POST", path, "198.51.100.22", null).statusCode());
    }

    @Test
    @DisplayName("Forged X-Forwarded-For entries do not give a client a new bucket")
    void forgedForwardedForDoesNotHelp() throws Exception {
        String path = "/api/rooms/RL3ABC/guest-token";
        for (int i = 0; i < 3; i++) {
            assertEquals(200, send("POST", path, "1.2.3." + i + ", 198.51.100.31", null).statusCode());
        }
        assertEquals(429, send("POST", path, "9.9.9.9, 198.51.100.31", null).statusCode());
    }

    @Test
    @DisplayName("Creating rooms is limited before authentication: a flood of bad tokens is cut without checking them")
    void roomCreationIsLimitedBeforeAuthentication(CapturedOutput output) throws Exception {
        for (int i = 0; i < 3; i++) assertEquals(401, send("POST", "/api/rooms", "198.51.100.41", null).statusCode());
        HttpResponse<String> refused = send("POST", "/api/rooms", "198.51.100.41", "seg3-before-auth");
        assertEquals(429, refused.statusCode());
        assertFalse(output.getAll().contains("\"event\":\"auth.rejected\",\"channel\":\"http\",\"code\":\"UNAUTHORIZED\","
                + "\"reason\":\"missing_token\",\"correlationId\":\"seg3-before-auth\""), "no token check, no auth line");
        // A registered user from another address still creates rooms.
        assertEquals(200, send("POST", "/api/rooms", "198.51.100.42", null, ENTRA.userToken("user-ana")).statusCode());
    }

    @Test
    @DisplayName("Opening Socket.IO connections is limited; an open long-polling session has its own bucket")
    void socketHandshakesAreLimited() throws Exception {
        String handshake = "/socket.io/?EIO=4&transport=websocket";
        for (int i = 0; i < 3; i++) assertEquals(200, send("GET", handshake, "198.51.100.51", null).statusCode());
        assertEquals(429, send("GET", handshake, "198.51.100.51", null).statusCode());
        assertEquals(200, send("GET", "/socket.io/?EIO=4&transport=polling&sid=abc", "198.51.100.51", null).statusCode());
    }

    @Test
    @DisplayName("Preflight requests and health checks are never limited")
    void preflightAndHealthAreNeverLimited() throws Exception {
        for (int i = 0; i < 10; i++) {
            HttpRequest preflight = HttpRequest.newBuilder(uri("/api/rooms"))
                    .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                    .header("Origin", ORIGIN)
                    .header("Access-Control-Request-Method", "POST")
                    .header("X-Forwarded-For", "198.51.100.61")
                    .build();
            assertEquals(200, client.send(preflight, HttpResponse.BodyHandlers.ofString()).statusCode());
            assertNotEquals(429, send("GET", "/actuator/health", "198.51.100.61", null).statusCode());
        }
    }

    // ---- Helpers ---------------------------------------------------------------------------

    private URI uri(String pathAndQuery) {
        return URI.create("http://localhost:" + gatewayPort + pathAndQuery);
    }

    private HttpResponse<String> send(String method, String pathAndQuery, String forwardedFor, String correlationId)
            throws Exception {
        return send(method, pathAndQuery, forwardedFor, correlationId, null);
    }

    private HttpResponse<String> send(String method, String pathAndQuery, String forwardedFor, String correlationId,
                                      String token) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(uri(pathAndQuery))
                .method(method, method.equals("GET")
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString("{\"displayName\":\"Ana\"}"))
                .header("Content-Type", "application/json")
                .header("Origin", ORIGIN)
                .header("X-Forwarded-For", forwardedFor);
        if (correlationId != null) request.header("X-Correlation-Id", correlationId);
        if (token != null) request.header("Authorization", "Bearer " + token);
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static long forwardedTo(UpstreamStub service, String request) {
        return service.requests().stream().filter(r -> r.equals(request)).count();
    }
}
