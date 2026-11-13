package com.dancesync.gateway;

import com.dancesync.gateway.support.FakeEntra;
import com.dancesync.gateway.support.UpstreamStub;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The gateway exposes match results read-only: GETs reach users-service, while the
 * internal PUT that battle-service uses is not routed. A stub HTTP server stands in for
 * users-service and records what reached it. The match history is for registered
 * users (SEG-1), so every request carries a valid Entra ID token.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class MatchesRouteTests {

    private static final FakeEntra ENTRA = new FakeEntra();
    private static final UpstreamStub USERS_SERVICE = new UpstreamStub();

    private final HttpClient client = HttpClient.newHttpClient();

    @Value("${local.server.port}")
    private int gatewayPort;

    @DynamicPropertySource
    static void routeToStub(DynamicPropertyRegistry registry) {
        registry.add("USERS_SERVICE_URL", USERS_SERVICE::url);
        registry.add("AZURE_TENANT_ID", () -> FakeEntra.TENANT_ID);
        registry.add("AZURE_CLIENT_ID", () -> FakeEntra.CLIENT_ID);
        registry.add("ENTRA_JWKS_URI", ENTRA::jwkSetUri);
    }

    @AfterAll
    static void stopStub() {
        USERS_SERVICE.stop();
        ENTRA.stop();
    }

    @BeforeEach
    void clearReceived() {
        USERS_SERVICE.clear();
    }

    @Test
    void getMatchByIdIsProxiedToUsersService() throws Exception {
        HttpResponse<String> response = send("GET", "/api/matches/11111111-2222-4333-8444-555555555555");

        assertEquals(200, response.statusCode());
        assertEquals("{\"stub\":true}", response.body());
        assertEquals(List.of("GET /api/matches/11111111-2222-4333-8444-555555555555"), USERS_SERVICE.requests());
    }

    @Test
    void listMatchesByRoomCodeIsProxiedWithItsQuery() throws Exception {
        HttpResponse<String> response = send("GET", "/api/matches?roomCode=ABC123");

        assertEquals(200, response.statusCode());
        assertEquals(List.of("GET /api/matches?roomCode=ABC123"), USERS_SERVICE.requests());
    }

    @Test
    void putMatchIsNotRouted() throws Exception {
        HttpResponse<String> response = send("PUT", "/api/matches/11111111-2222-4333-8444-555555555555");

        assertEquals(404, response.statusCode());
        assertTrue(USERS_SERVICE.requests().isEmpty(), "the PUT must not reach users-service");
    }

    @Test
    void usersRouteStillWorks() throws Exception {
        HttpResponse<String> response = send("GET", "/api/users/11111111-2222-4333-8444-555555555555");

        assertEquals(200, response.statusCode());
        assertEquals(List.of("GET /api/users/11111111-2222-4333-8444-555555555555"), USERS_SERVICE.requests());
    }

    private HttpResponse<String> send(String method, String pathAndQuery) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + gatewayPort + pathAndQuery))
                .method(method, method.equals("GET")
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString("{}"))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + ENTRA.userToken("user-ana"))
                .build();
        return client.send(request, HttpResponse.BodyHandlers.ofString());
    }
}
