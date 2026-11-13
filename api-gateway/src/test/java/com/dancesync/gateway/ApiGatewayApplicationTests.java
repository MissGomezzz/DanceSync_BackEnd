package com.dancesync.gateway;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The gateway as it starts with no authentication settings at all (no tenant,
 * no guest secret): it must still start, and fail closed.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ApiGatewayApplicationTests {

	@Value("${local.server.port}")
	private int gatewayPort;

	@Test
	void contextLoads() {
	}

	@Test
	void withoutAuthenticationSettingsEveryTokenIsRefused() throws Exception {
		// A well-formed token of an issuer nobody configured: there are no keys to trust.
		String token = "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJkYW5jZXN5bmMtYmF0dGxlLXNlcnZpY2UiLCJzdWIiOiJ4In0.c2ln";
		assertEquals(401, get("/api/matches/1", null));
		assertEquals(401, get("/api/matches/1", token));
		assertEquals(401, get("/api/rooms/ABC123", token));
		assertEquals(200, get("/actuator/health", null));
	}

	private int get(String path, String token) throws Exception {
		HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + gatewayPort + path)).GET();
		if (token != null) request.header("Authorization", "Bearer " + token);
		return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.discarding()).statusCode();
	}

}
