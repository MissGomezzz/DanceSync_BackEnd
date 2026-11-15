package com.dancesync.gateway;

import com.dancesync.gateway.support.FakeEntra;
import com.dancesync.gateway.support.UpstreamStub;
import com.dancesync.gateway.support.UpstreamStub.Received;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * SEG-2 (non-repudiation) at the API gateway, over real HTTP: every request to the backend yields
 * one audit record delivered to users-service with the user taken from the token, the client
 * address, the UTC time, the User-Agent, the action and the correlation id; the token is never part
 * of it. Also: the admin screen's API is for the single admin account only.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class Seg2AuditTests {

    private static final FakeEntra ENTRA = new FakeEntra();
    private static final UpstreamStub USERS_SERVICE = new UpstreamStub();
    private static final UpstreamStub BATTLE_SERVICE = new UpstreamStub();

    static final String INTERNAL_TOKEN = "test-internal-token-of-at-least-32-bytes";
    private static final String ADMIN_OID = "user-admin";
    private static final String FIREFOX = "Mozilla/5.0 (Windows NT 10.0; rv:133.0) Gecko/20100101 Firefox/133.0";
    private static final String INGEST = "POST /internal/audit/events";

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
        registry.add("ADMIN_USER_OID", () -> ADMIN_OID);
        registry.add("AUDIT_INTERNAL_TOKEN", () -> INTERNAL_TOKEN);
        registry.add("AUDIT_FLUSH_INTERVAL", () -> "PT0.1S");
        // The test client plays the platform ingress: its X-Forwarded-For entry is trusted.
        registry.add("TRUSTED_PROXY_HOPS", () -> "1");
    }

    @AfterAll
    static void stopStubs() {
        USERS_SERVICE.stop();
        BATTLE_SERVICE.stop();
        ENTRA.stop();
    }

    @BeforeEach
    void clearReceived() {
        USERS_SERVICE.clear();
        BATTLE_SERVICE.clear();
    }

    @Test
    @DisplayName("An authorized request is recorded with the 5 fields, the action and the correlation id")
    void recordsAnAuthorizedRequest() throws Exception {
        HttpResponse<String> response = send("GET", "/api/matches?roomCode=ABC123", ENTRA.userToken("user-ana"),
                Map.of("X-Forwarded-For", "203.0.113.7", "User-Agent", FIREFOX, "X-Correlation-Id", "seg2-gw-1"));
        assertThat(response.statusCode()).isEqualTo(200);

        String record = awaitRecord("seg2-gw-1");
        assertThat(record)
                .contains("\"userId\":\"user-ana\"")
                .contains("\"userKind\":\"user\"")
                .contains("\"userName\":\"Ana\"")
                .contains("\"ip\":\"203.0.113.7\"")
                .contains("\"userAgent\":\"" + FIREFOX + "\"")
                .contains("\"action\":\"GET /api/matches\"")
                .contains("\"channel\":\"http\"")
                .contains("\"outcome\":\"ok\"")
                .contains("\"status\":200")
                .contains("\"source\":\"api-gateway@")
                .containsPattern("\"occurredAt\":\"\\d{4}-\\d{2}-\\d{2}T[0-9:.]+Z\"")
                .containsPattern("\"eventId\":\"[0-9a-f-]{36}\"");
        // The query string is not an action and may carry data: it is not recorded.
        assertThat(record).doesNotContain("roomCode=ABC123");
    }

    @Test
    @DisplayName("The batch reaches users-service with the internal secret and without the user's token")
    void deliversWithTheInternalSecretAndWithoutTheToken() throws Exception {
        String token = ENTRA.userToken("user-ana");
        send("GET", "/api/matches?roomCode=ABC123", token, Map.of("X-Correlation-Id", "seg2-gw-2"));

        awaitRecord("seg2-gw-2");
        Received ingest = ingestRequests().get(0);
        assertThat(ingest.internalToken()).isEqualTo(INTERNAL_TOKEN);
        assertThat(ingest.authorization()).isNull();
        assertThat(ingestRequests()).allSatisfy(r -> assertThat(r.body()).doesNotContain(token));
    }

    @Test
    @DisplayName("A refused request is recorded as anonymous and rejected, with the reason")
    void recordsARefusedRequest() throws Exception {
        HttpResponse<String> response = send("POST", "/api/rooms", null,
                Map.of("X-Forwarded-For", "198.51.100.9", "User-Agent", "curl/8.11", "X-Correlation-Id", "seg2-gw-3"));
        assertThat(response.statusCode()).isEqualTo(401);

        assertThat(awaitRecord("seg2-gw-3"))
                .contains("\"userKind\":\"anonymous\"")
                .doesNotContain("\"userId\"")
                .contains("\"outcome\":\"rejected\"")
                .contains("\"status\":401")
                .contains("\"code\":\"missing_token\"")
                .contains("\"ip\":\"198.51.100.9\"")
                .contains("\"userAgent\":\"curl/8.11\"");
    }

    @Test
    @DisplayName("A guest outside its room is recorded with its identity and refused")
    void recordsAGuestOutOfScope() throws Exception {
        HttpResponse<String> response = send("GET", "/api/rooms/OTHER1", ENTRA.guestToken("ABC123"),
                Map.of("X-Correlation-Id", "seg2-gw-4"));
        assertThat(response.statusCode()).isEqualTo(403);

        assertThat(awaitRecord("seg2-gw-4"))
                .contains("\"userKind\":\"guest\"")
                .contains("\"userId\":\"guest-")
                .contains("\"outcome\":\"rejected\"")
                .contains("\"code\":\"guest_out_of_scope\"");
    }

    @Test
    @DisplayName("CORS preflights are not actions and are not recorded")
    void preflightsAreNotRecorded() throws Exception {
        send("OPTIONS", "/api/rooms", null, Map.of("Origin", "http://localhost:5173",
                "Access-Control-Request-Method", "POST", "X-Correlation-Id", "seg2-gw-5"));
        send("GET", "/api/matches?roomCode=X", ENTRA.userToken("user-ana"), Map.of("X-Correlation-Id", "seg2-gw-6"));

        awaitRecord("seg2-gw-6");
        assertThat(ingestRequests()).noneSatisfy(r -> assertThat(r.body()).contains("seg2-gw-5"));
    }

    @Test
    @DisplayName("Only the admin account reaches the admin API, which gets the internal secret")
    void theAdminApiIsForTheAdminOnly() throws Exception {
        assertThat(send("GET", "/api/admin/session", null, Map.of()).statusCode()).isEqualTo(401);
        assertThat(send("GET", "/api/admin/session", ENTRA.userToken("user-ana"),
                Map.of("X-Correlation-Id", "seg2-gw-not-admin")).statusCode()).isEqualTo(403);
        assertThat(awaitRecord("seg2-gw-not-admin")).contains("\"userId\":\"user-ana\"")
                .contains("\"code\":\"not_admin\"");
        assertThat(send("GET", "/api/admin/audit/records", ENTRA.guestToken("ABC123"), Map.of()).statusCode())
                .isEqualTo(403);
        assertThat(adminRequests()).isEmpty();

        assertThat(send("GET", "/api/admin/session", ENTRA.userToken(ADMIN_OID), Map.of()).statusCode())
                .isEqualTo(200);
        assertThat(adminRequests()).singleElement()
                .satisfies(r -> assertThat(r.internalToken()).isEqualTo(INTERNAL_TOKEN));
    }

    @Test
    @DisplayName("GET /api/me tells anyone signed in whether they are the admin, recorded as a normal request")
    void meTellsWhetherTheUserIsTheAdminWithoutA403() throws Exception {
        HttpResponse<String> ana = send("GET", "/api/me", ENTRA.userToken("user-ana"), Map.of("X-Correlation-Id", "seg2-me-ana"));
        assertThat(ana.statusCode()).isEqualTo(200);
        assertThat(ana.body()).contains("\"admin\":false").contains("\"userId\":\"user-ana\"").contains("\"kind\":\"user\"");
        // Signing in is not an attempt to open the admin screen: the record is a plain "ok".
        assertThat(awaitRecord("seg2-me-ana")).contains("\"outcome\":\"ok\"").contains("\"status\":200")
                .doesNotContain("not_admin");

        HttpResponse<String> admin = send("GET", "/api/me", ENTRA.userToken(ADMIN_OID), Map.of());
        assertThat(admin.body()).contains("\"admin\":true");
        assertThat(send("GET", "/api/me", ENTRA.guestToken("ABC123"), Map.of()).body())
                .contains("\"kind\":\"guest\"").contains("\"admin\":false");
        assertThat(send("GET", "/api/me", null, Map.of()).statusCode()).isEqualTo(401);
        // Answered by the gateway: nothing reaches users-service.
        assertThat(USERS_SERVICE.received()).noneSatisfy(r -> assertThat(r.pathAndQuery()).startsWith("/api/me"));
    }

    @Test
    @DisplayName("A client cannot send the internal secret itself")
    void aClientSentInternalSecretIsRemoved() throws Exception {
        send("GET", "/api/users/42", ENTRA.userToken("user-ana"), Map.of("X-Internal-Token", INTERNAL_TOKEN));

        Received forwarded = USERS_SERVICE.received().stream()
                .filter(r -> r.pathAndQuery().startsWith("/api/users/")).findFirst().orElseThrow();
        assertThat(forwarded.internalToken()).isNull();
    }

    @Test
    @DisplayName("battle-service receives the client's address chain, so its records name the client too")
    void forwardsTheClientAddressChain() throws Exception {
        send("GET", "/api/rooms/ABC123", ENTRA.userToken("user-ana"), Map.of("X-Forwarded-For", "203.0.113.7"));

        Received forwarded = BATTLE_SERVICE.received().stream()
                .filter(r -> r.pathAndQuery().startsWith("/api/rooms/ABC123")).findFirst().orElseThrow();
        // The ingress's entry is kept and the gateway appends the address it saw (loopback here).
        assertThat(forwarded.forwardedFor()).startsWith("203.0.113.7,").contains("127.0.0.1");
    }

    private List<Received> ingestRequests() {
        return USERS_SERVICE.received().stream().filter(r -> (r.method() + " " + r.pathAndQuery()).equals(INGEST)).toList();
    }

    private List<Received> adminRequests() {
        return USERS_SERVICE.received().stream().filter(r -> r.pathAndQuery().startsWith("/api/admin")).toList();
    }

    /** The record whose correlation id is given, once the shipper delivered it (it flushes every 100 ms). */
    private String awaitRecord(String correlationId) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5_000;
        String needle = "\"correlationId\":\"" + correlationId + "\"";
        while (System.currentTimeMillis() < deadline) {
            for (Received ingest : ingestRequests()) {
                int at = ingest.body().indexOf(needle);
                if (at >= 0) {
                    int start = ingest.body().lastIndexOf('{', at);
                    int end = ingest.body().indexOf('}', at);
                    return ingest.body().substring(start, end + 1);
                }
            }
            Thread.sleep(50);
        }
        throw new AssertionError("No audit record with correlation id " + correlationId + " reached users-service");
    }

    private HttpResponse<String> send(String method, String path, String token, Map<String, String> headers)
            throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + gatewayPort + path))
                .method(method, HttpRequest.BodyPublishers.noBody());
        if (token != null) request.header("Authorization", "Bearer " + token);
        headers.forEach((name, value) -> {
            if (!name.equalsIgnoreCase("User-Agent")) request.header(name, value);
        });
        if (headers.containsKey("User-Agent")) request.setHeader("User-Agent", headers.get("User-Agent"));
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }
}
