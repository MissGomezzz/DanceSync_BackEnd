package com.dancesync.gateway;

import com.dancesync.gateway.support.FakeEntra;
import com.dancesync.gateway.support.UpstreamStub;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SEG-1 (security, authentication) at the API gateway, over real HTTP. The
 * gateway runs with its production security configuration; only the tenant's
 * key set points at a local JWKS endpoint, and stub servers stand in for
 * users-service and battle-service to prove that a refused request is never
 * forwarded.
 *
 * <p>The two protected actions of the scenario, creating a room and reading
 * the match history, are tried with the six token cases: absent, expired,
 * tampered, issued for another audience, guest outside its scope, and valid.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ExtendWith(OutputCaptureExtension.class)
class Seg1SecurityTests {

    private static final FakeEntra ENTRA = new FakeEntra();
    private static final UpstreamStub USERS_SERVICE = new UpstreamStub();
    private static final UpstreamStub BATTLE_SERVICE = new UpstreamStub();

    private static final String MATCH_HISTORY = "/api/matches/11111111-2222-4333-8444-555555555555";
    private static final String CREATE_ROOM = "/api/rooms";
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

    @BeforeEach
    void clearReceived() {
        USERS_SERVICE.clear();
        BATTLE_SERVICE.clear();
    }

    // ---- Case 1: absent token -------------------------------------------------------------

    @Test
    @DisplayName("Case 1, absent token: creating a room is refused with 401 and never forwarded")
    void createRoomWithoutTokenIsRefused(CapturedOutput output) throws Exception {
        assertRefused(output, "POST", CREATE_ROOM, null, 401, "missing_token");
    }

    @Test
    @DisplayName("Case 1, absent token: reading the match history is refused with 401 and never forwarded")
    void matchHistoryWithoutTokenIsRefused(CapturedOutput output) throws Exception {
        assertRefused(output, "GET", MATCH_HISTORY, null, 401, "missing_token");
    }

    // ---- Case 2: expired token ------------------------------------------------------------

    @Test
    @DisplayName("Case 2, expired token: creating a room is refused with 401")
    void createRoomWithExpiredTokenIsRefused(CapturedOutput output) throws Exception {
        assertRefused(output, "POST", CREATE_ROOM, ENTRA.expiredUserToken("user-ana"), 401, "expired_token");
    }

    @Test
    @DisplayName("Case 2, expired token: reading the match history is refused with 401")
    void matchHistoryWithExpiredTokenIsRefused(CapturedOutput output) throws Exception {
        assertRefused(output, "GET", MATCH_HISTORY, ENTRA.expiredUserToken("user-ana"), 401, "expired_token");
    }

    // ---- Case 3: tampered token -----------------------------------------------------------

    @Test
    @DisplayName("Case 3, tampered token: an edited payload (becoming another user) is refused with 401")
    void editedPayloadIsRefused(CapturedOutput output) throws Exception {
        String tampered = FakeEntra.tamperedPayload(ENTRA.userToken("user-mallory"), "oid", "user-ana");
        assertRefused(output, "POST", CREATE_ROOM, tampered, 401, "invalid_signature");
        assertRefused(output, "GET", MATCH_HISTORY, tampered, 401, "invalid_signature");
    }

    @Test
    @DisplayName("Case 3, tampered token: a signature that is not the tenant's is refused with 401")
    void foreignSignatureIsRefused(CapturedOutput output) throws Exception {
        String forged = ENTRA.forgedUserToken("user-ana");
        assertRefused(output, "POST", CREATE_ROOM, forged, 401, "invalid_signature");
        assertRefused(output, "GET", MATCH_HISTORY, forged, 401, "invalid_signature");
    }

    @Test
    @DisplayName("Case 3, tampered token: an unsigned token (alg none) and plain garbage are refused with 401")
    void unsignedAndMalformedTokensAreRefused(CapturedOutput output) throws Exception {
        String unsigned = FakeEntra.unsigned(ENTRA.userToken("user-ana"));
        assertRefused(output, "POST", CREATE_ROOM, unsigned, 401, "invalid_signature");
        assertRefused(output, "GET", MATCH_HISTORY, unsigned, 401, "invalid_signature");
        assertRefused(output, "GET", MATCH_HISTORY, "not-a-jwt", 401, "malformed_token");
    }

    // ---- Case 4: token issued for another audience ----------------------------------------

    @Test
    @DisplayName("Case 4, another audience: a genuine Entra ID token issued for another API is refused with 401")
    void tokenForAnotherAudienceIsRefused(CapturedOutput output) throws Exception {
        String otherApi = ENTRA.userTokenForAudience("user-ana", "99999999-9999-4999-8999-999999999999");
        assertRefused(output, "POST", CREATE_ROOM, otherApi, 401, "wrong_audience");
        assertRefused(output, "GET", MATCH_HISTORY, otherApi, 401, "wrong_audience");
    }

    @Test
    @DisplayName("A token from another issuer (another tenant) is refused with 401")
    void tokenFromAnotherIssuerIsRefused(CapturedOutput output) throws Exception {
        String otherTenant = ENTRA.userToken("user-ana",
                claims -> claims.issuer("https://login.microsoftonline.com/33333333-3333-4333-8333-333333333333/v2.0"));
        assertRefused(output, "GET", MATCH_HISTORY, otherTenant, 401, "wrong_issuer");
    }

    // ---- Case 5: guest token outside its scope --------------------------------------------

    @Test
    @DisplayName("Case 5, guest outside its scope: a guest cannot create rooms (403)")
    void guestCannotCreateRooms(CapturedOutput output) throws Exception {
        assertRefused(output, "POST", CREATE_ROOM, ENTRA.guestToken("ABC123"), 403, "guest_out_of_scope");
    }

    @Test
    @DisplayName("Case 5, guest outside its scope: a guest cannot read the match history (403)")
    void guestCannotReadTheMatchHistory(CapturedOutput output) throws Exception {
        String guest = ENTRA.guestToken("ABC123");
        assertRefused(output, "GET", MATCH_HISTORY, guest, 403, "guest_out_of_scope");
        assertRefused(output, "GET", "/api/matches?roomCode=ABC123", guest, 403, "guest_out_of_scope");
        assertRefused(output, "GET", "/api/users/11111111-2222-4333-8444-555555555555", guest, 403,
                "guest_out_of_scope");
    }

    @Test
    @DisplayName("Case 5, guest outside its scope: a guest token is valid for its own room only")
    void guestTokenIsValidForItsRoomOnly(CapturedOutput output) throws Exception {
        String guest = ENTRA.guestToken("ABC123");
        assertRefused(output, "GET", "/api/rooms/XYZ789", guest, 403, "guest_out_of_scope");

        HttpResponse<String> own = send("GET", "/api/rooms/abc123", guest);
        assertEquals(200, own.statusCode());
        assertEquals(List.of("GET /api/rooms/abc123"), BATTLE_SERVICE.requests());
    }

    @Test
    @DisplayName("An expired guest token, one for another audience or one signed with another secret is refused with 401")
    void invalidGuestTokensAreRefused(CapturedOutput output) throws Exception {
        String expired = ENTRA.expiredGuestToken("ABC123");
        String otherAudience = ENTRA.guestToken("ABC123", FakeEntra.GUEST_SECRET, claims -> claims.audience("other"));
        String otherSecret = ENTRA.guestToken("ABC123", "another-secret-that-is-32-bytes-long!!!", claims -> { });
        assertRefused(output, "GET", "/api/rooms/ABC123", expired, 401, "expired_token");
        assertRefused(output, "GET", "/api/rooms/ABC123", otherAudience, 401, "wrong_audience");
        assertRefused(output, "GET", "/api/rooms/ABC123", otherSecret, 401, "invalid_signature");
    }

    // ---- Case 6: valid token --------------------------------------------------------------

    @Test
    @DisplayName("Case 6, valid token: a registered user creates a room; the request is forwarded with its token")
    void registeredUserCreatesARoom() throws Exception {
        String token = ENTRA.userToken("user-ana");
        HttpResponse<String> response = send("POST", CREATE_ROOM, token);

        assertEquals(200, response.statusCode());
        assertEquals("{\"stub\":true}", response.body());
        assertEquals(List.of("POST /api/rooms"), BATTLE_SERVICE.requests());
        // battle-service validates the same token again and takes the host from it.
        assertEquals("Bearer " + token, BATTLE_SERVICE.received().get(0).authorization());
    }

    @Test
    @DisplayName("Case 6, valid token: a registered user reads the match history")
    void registeredUserReadsTheMatchHistory() throws Exception {
        HttpResponse<String> response = send("GET", MATCH_HISTORY, ENTRA.userToken("user-ana"));

        assertEquals(200, response.statusCode());
        assertEquals(List.of("GET " + MATCH_HISTORY), USERS_SERVICE.requests());
    }

    // ---- Response measure: 100 % refused, every refusal recorded ---------------------------

    @Test
    @DisplayName("100 % of the requests without a valid token are refused, on every protected route")
    void everyRequestWithoutAValidTokenIsRefused() throws Exception {
        Map<String, String> invalidTokens = new LinkedHashMap<>();
        invalidTokens.put("absent", null);
        invalidTokens.put("garbage", "garbage");
        invalidTokens.put("expired", ENTRA.expiredUserToken("user-ana"));
        invalidTokens.put("edited payload", FakeEntra.tamperedPayload(ENTRA.userToken("user-mallory"), "oid", "user-ana"));
        invalidTokens.put("foreign signature", ENTRA.forgedUserToken("user-ana"));
        invalidTokens.put("unsigned", FakeEntra.unsigned(ENTRA.userToken("user-ana")));
        invalidTokens.put("another audience", ENTRA.userTokenForAudience("user-ana", "another-api"));
        invalidTokens.put("another issuer", ENTRA.userToken("user-ana", claims -> claims.issuer("https://evil.example/v2.0")));
        invalidTokens.put("expired guest", ENTRA.expiredGuestToken("ABC123"));
        List<String[]> protectedRoutes = List.of(
                new String[] {"POST", "/api/rooms"},
                new String[] {"GET", "/api/rooms/ABC123"},
                new String[] {"GET", MATCH_HISTORY},
                new String[] {"GET", "/api/matches?roomCode=ABC123"},
                new String[] {"GET", "/api/users/11111111-2222-4333-8444-555555555555"},
                new String[] {"POST", "/api/users"},
                new String[] {"GET", "/actuator/gateway/routes"},
                new String[] {"GET", "/api/anything-else"});

        int refused = 0;
        for (Map.Entry<String, String> token : invalidTokens.entrySet()) {
            for (String[] route : protectedRoutes) {
                HttpResponse<String> response = send(route[0], route[1], token.getValue());
                assertEquals(401, response.statusCode(), route[0] + " " + route[1] + " with token: " + token.getKey());
                refused++;
            }
        }

        assertEquals(invalidTokens.size() * protectedRoutes.size(), refused);
        assertNothingForwarded();
    }

    @Test
    @DisplayName("Every refusal is logged with the correlation id and without the token")
    void refusalsAreLoggedWithTheCorrelationIdAndWithoutTheToken(CapturedOutput output) throws Exception {
        String token = ENTRA.expiredUserToken("user-ana");
        HttpResponse<String> response = send("GET", MATCH_HISTORY + "?secret=in-the-query", token, "seg1-audit-trail");

        assertEquals(401, response.statusCode());
        assertEquals("seg1-audit-trail", response.headers().firstValue("X-Correlation-Id").orElse(null));
        assertEquals("{\"error\":\"A valid access token is required\",\"code\":\"UNAUTHORIZED\","
                + "\"correlationId\":\"seg1-audit-trail\"}", response.body());
        assertEquals("Bearer", response.headers().firstValue("WWW-Authenticate").orElse(null));

        String log = output.getAll();
        assertTrue(log.contains("{\"event\":\"auth.rejected\",\"channel\":\"http\",\"code\":\"UNAUTHORIZED\","
                + "\"reason\":\"expired_token\",\"correlationId\":\"seg1-audit-trail\",\"method\":\"GET\","
                + "\"path\":\"" + MATCH_HISTORY + "\"}"), "the refusal is not in the log");
        assertFalse(log.contains(token), "the token was logged");
        // Not even its parts, and nothing else the caller sent.
        for (String part : token.split("\\.")) assertFalse(log.contains(part), "a part of the token was logged");
        assertFalse(log.contains("in-the-query"), "the query string was logged");
    }

    @Test
    @DisplayName("The correlation id is created when missing, replaced when unsafe and forwarded downstream")
    void correlationIdIsCreatedSanitizedAndForwarded(CapturedOutput output) throws Exception {
        HttpResponse<String> generated = send("GET", MATCH_HISTORY, null);
        String correlationId = generated.headers().firstValue("X-Correlation-Id").orElse(null);
        assertNotNull(correlationId);
        assertTrue(correlationId.matches("[0-9a-f-]{36}"), correlationId);
        assertTrue(output.getAll().contains("\"correlationId\":\"" + correlationId + "\""));

        HttpResponse<String> unsafe = send("GET", MATCH_HISTORY, null, "forged\",\"event\":\"x");
        String replaced = unsafe.headers().firstValue("X-Correlation-Id").orElse("");
        assertTrue(replaced.matches("[0-9a-f-]{36}"), replaced);
        assertFalse(output.getAll().contains("forged"), "a caller injected text into the log");

        send("GET", MATCH_HISTORY, ENTRA.userToken("user-ana"), "seg1-forwarded");
        assertEquals("seg1-forwarded", USERS_SERVICE.received().get(0).correlationId());
    }

    // ---- What stays open, and why ----------------------------------------------------------

    @Test
    @DisplayName("Open on purpose: health checks, the guest token and what battle-service authenticates itself")
    void routesThatNeedNoTokenAtTheGateway() throws Exception {
        assertEquals(200, send("GET", "/api/battles/health", null).statusCode());
        // How a guest gets a token: there is nothing to present yet.
        assertEquals(200, send("POST", "/api/rooms/ABC123/guest-token", null).statusCode());
        // The token is in the body (sendBeacon cannot set headers): battle-service validates it.
        assertEquals(200, send("POST", "/api/rooms/ABC123/leave", null).statusCode());
        // The token is in the Socket.IO handshake, which the gateway only proxies: battle-service validates it.
        assertEquals(200, send("GET", "/socket.io/?EIO=4&transport=polling", null).statusCode());

        assertEquals(List.of(
                "GET /api/battles/health",
                "POST /api/rooms/ABC123/guest-token",
                "POST /api/rooms/ABC123/leave",
                "GET /socket.io/?EIO=4&transport=polling"), BATTLE_SERVICE.requests());
    }

    @Test
    @DisplayName("The browser can read a 401: preflights pass without a token and refusals carry the CORS headers")
    void corsHeadersArePresentOnPreflightsAndRefusals() throws Exception {
        HttpRequest preflight = HttpRequest.newBuilder(URI.create("http://localhost:" + gatewayPort + CREATE_ROOM))
                .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                .header("Origin", ORIGIN)
                .header("Access-Control-Request-Method", "POST")
                .header("Access-Control-Request-Headers", "authorization,content-type")
                .build();
        HttpResponse<String> allowed = client.send(preflight, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, allowed.statusCode());
        assertEquals(ORIGIN, allowed.headers().firstValue("Access-Control-Allow-Origin").orElse(null));

        HttpRequest unauthenticated = HttpRequest.newBuilder(URI.create("http://localhost:" + gatewayPort + CREATE_ROOM))
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .header("Origin", ORIGIN)
                .header("Content-Type", "application/json")
                .build();
        HttpResponse<String> refused = client.send(unauthenticated, HttpResponse.BodyHandlers.ofString());
        assertEquals(401, refused.statusCode());
        assertEquals(List.of(ORIGIN), refused.headers().allValues("Access-Control-Allow-Origin"));

        // A forwarded answer still carries the header exactly once.
        HttpRequest authenticated = HttpRequest.newBuilder(URI.create("http://localhost:" + gatewayPort + MATCH_HISTORY))
                .GET()
                .header("Origin", ORIGIN)
                .header("Authorization", "Bearer " + ENTRA.userToken("user-ana"))
                .build();
        HttpResponse<String> forwarded = client.send(authenticated, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, forwarded.statusCode());
        assertEquals(List.of(ORIGIN), forwarded.headers().allValues("Access-Control-Allow-Origin"));
    }

    // ---- Helpers ---------------------------------------------------------------------------

    /** The request must get {@code status}, reach no service and leave one audit line with {@code reason}. */
    private void assertRefused(CapturedOutput output, String method, String pathAndQuery, String token, int status,
                               String reason) throws Exception {
        String correlationId = "seg1-" + reason + "-" + System.nanoTime();
        HttpResponse<String> response = send(method, pathAndQuery, token, correlationId);

        assertEquals(status, response.statusCode(), method + " " + pathAndQuery);
        String code = status == 401 ? "UNAUTHORIZED" : "FORBIDDEN";
        assertTrue(response.body().contains("\"code\":\"" + code + "\""), response.body());
        assertTrue(response.body().contains("\"correlationId\":\"" + correlationId + "\""), response.body());
        assertNothingForwarded();

        String path = pathAndQuery.contains("?") ? pathAndQuery.substring(0, pathAndQuery.indexOf('?')) : pathAndQuery;
        String expected = "{\"event\":\"auth.rejected\",\"channel\":\"http\",\"code\":\"" + code + "\",\"reason\":\""
                + reason + "\",\"correlationId\":\"" + correlationId + "\",\"method\":\"" + method + "\",\"path\":\""
                + path + "\"}";
        assertTrue(output.getAll().contains(expected), "missing audit line: " + expected);
        if (token != null) assertFalse(output.getAll().contains(token), "the token was logged");
    }

    private void assertNothingForwarded() {
        assertTrue(USERS_SERVICE.requests().isEmpty(), "reached users-service: " + USERS_SERVICE.requests());
        assertTrue(BATTLE_SERVICE.requests().isEmpty(), "reached battle-service: " + BATTLE_SERVICE.requests());
    }

    private HttpResponse<String> send(String method, String pathAndQuery, String token) throws Exception {
        return send(method, pathAndQuery, token, null);
    }

    private HttpResponse<String> send(String method, String pathAndQuery, String token, String correlationId)
            throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + gatewayPort + pathAndQuery))
                .method(method, method.equals("GET")
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString("{\"displayName\":\"Ana\"}"))
                .header("Content-Type", "application/json");
        if (token != null) request.header("Authorization", "Bearer " + token);
        if (correlationId != null) request.header("X-Correlation-Id", correlationId);
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }
}
