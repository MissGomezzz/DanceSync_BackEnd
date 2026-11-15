package com.dancesync.gateway.ratelimit;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class HttpRateLimiterPolicyTests {

    private static String policy(HttpMethod method, String uri) {
        return HttpRateLimiter.policyOf(MockServerHttpRequest.method(method, uri).build());
    }

    @Test
    @DisplayName("Each kind of request gets its policy")
    void policies() {
        assertEquals(HttpRateLimiter.ROOM_CREATE, policy(HttpMethod.POST, "/api/rooms"));
        assertEquals(HttpRateLimiter.GUEST_TOKEN, policy(HttpMethod.POST, "/api/rooms/ABC123/guest-token"));
        assertEquals(HttpRateLimiter.SOCKET_HANDSHAKE, policy(HttpMethod.GET, "/socket.io/?EIO=4&transport=websocket"));
        assertEquals(HttpRateLimiter.SOCKET_HANDSHAKE, policy(HttpMethod.GET, "/socket.io/?EIO=4&transport=polling"));
        assertEquals(HttpRateLimiter.SOCKET_POLLING, policy(HttpMethod.POST, "/socket.io/?EIO=4&transport=polling&sid=abc"));
        assertEquals(HttpRateLimiter.OTHER, policy(HttpMethod.GET, "/api/rooms/ABC123"));
        assertEquals(HttpRateLimiter.OTHER, policy(HttpMethod.POST, "/api/rooms/ABC123/leave"));
        assertEquals(HttpRateLimiter.OTHER, policy(HttpMethod.GET, "/api/matches/1"));
    }

    @Test
    @DisplayName("Preflight requests and health checks are never limited")
    void exempt() {
        assertNull(policy(HttpMethod.OPTIONS, "/api/rooms"));
        assertNull(policy(HttpMethod.GET, "/actuator/health"));
        assertNull(policy(HttpMethod.GET, "/actuator/health/liveness"));
        assertNull(policy(HttpMethod.GET, "/api/battles/health"));
    }
}
