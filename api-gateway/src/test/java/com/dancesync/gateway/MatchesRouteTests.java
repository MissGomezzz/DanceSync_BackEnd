package com.dancesync.gateway;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The gateway exposes match results read-only: GETs reach users-service, while the
 * internal PUT that battle-service uses is not routed. A stub HTTP server stands in for
 * users-service and records what reached it.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class MatchesRouteTests {

    private static final List<String> RECEIVED = new CopyOnWriteArrayList<>();
    private static final HttpServer USERS_SERVICE = startUsersServiceStub();

    private final HttpClient client = HttpClient.newHttpClient();

    @Value("${local.server.port}")
    private int gatewayPort;

    @DynamicPropertySource
    static void routeToStub(DynamicPropertyRegistry registry) {
        registry.add("USERS_SERVICE_URL", () -> "http://localhost:" + USERS_SERVICE.getAddress().getPort());
    }

    @AfterAll
    static void stopStub() {
        USERS_SERVICE.stop(0);
    }

    @BeforeEach
    void clearReceived() {
        RECEIVED.clear();
    }

    @Test
    void getMatchByIdIsProxiedToUsersService() throws Exception {
        HttpResponse<String> response = send("GET", "/api/matches/11111111-2222-4333-8444-555555555555");

        assertEquals(200, response.statusCode());
        assertEquals("{\"stub\":true}", response.body());
        assertEquals(List.of("GET /api/matches/11111111-2222-4333-8444-555555555555"), RECEIVED);
    }

    @Test
    void listMatchesByRoomCodeIsProxiedWithItsQuery() throws Exception {
        HttpResponse<String> response = send("GET", "/api/matches?roomCode=ABC123");

        assertEquals(200, response.statusCode());
        assertEquals(List.of("GET /api/matches?roomCode=ABC123"), RECEIVED);
    }

    @Test
    void putMatchIsNotRouted() throws Exception {
        HttpResponse<String> response = send("PUT", "/api/matches/11111111-2222-4333-8444-555555555555");

        assertEquals(404, response.statusCode());
        assertTrue(RECEIVED.isEmpty(), "the PUT must not reach users-service");
    }

    @Test
    void usersRouteStillWorks() throws Exception {
        HttpResponse<String> response = send("GET", "/api/users/11111111-2222-4333-8444-555555555555");

        assertEquals(200, response.statusCode());
        assertEquals(List.of("GET /api/users/11111111-2222-4333-8444-555555555555"), RECEIVED);
    }

    private HttpResponse<String> send(String method, String pathAndQuery) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + gatewayPort + pathAndQuery))
                .method(method, method.equals("GET")
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString("{}"))
                .header("Content-Type", "application/json")
                .build();
        return client.send(request, HttpResponse.BodyHandlers.ofString());
    }

    private static HttpServer startUsersServiceStub() {
        try {
            HttpServer server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
            server.createContext("/", exchange -> {
                URI uri = exchange.getRequestURI();
                RECEIVED.add(exchange.getRequestMethod() + " " + uri.getRawPath()
                        + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery()));
                byte[] body = "{\"stub\":true}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, body.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(body);
                }
            });
            server.start();
            return server;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
