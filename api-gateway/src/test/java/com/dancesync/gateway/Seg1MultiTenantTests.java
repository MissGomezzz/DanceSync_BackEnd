package com.dancesync.gateway;

import com.dancesync.gateway.support.FakeEntra;
import com.dancesync.gateway.support.UpstreamStub;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
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
 * SEG-1 with a multi-tenant application: users of any organization sign in without being
 * invited, and every token is still fully validated (signature, expiry, audience, issuer).
 */
class Seg1MultiTenantTests {

    static final FakeEntra ENTRA = new FakeEntra();
    static final UpstreamStub USERS_SERVICE = new UpstreamStub();
    static final String OTHER_TENANT = "33333333-3333-4333-8333-333333333333";
    static final String PERSONAL = "9188040d-6c67-4c5b-b112-36a304b66dad";
    static final String HISTORY = "/api/matches/11111111-2222-4333-8444-555555555555";

    @AfterAll
    static void stop() {
        USERS_SERVICE.stop();
        ENTRA.stop();
    }

    static void configure(DynamicPropertyRegistry registry, String tenancy) {
        registry.add("USERS_SERVICE_URL", USERS_SERVICE::url);
        registry.add("AZURE_TENANT_ID", () -> tenancy);
        registry.add("AZURE_CLIENT_ID", () -> FakeEntra.CLIENT_ID);
        registry.add("ENTRA_JWKS_URI", ENTRA::jwkSetUri);
    }

    static int get(int port, String token) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + HISTORY))
                .GET().header("Authorization", "Bearer " + token).build();
        return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
    }

    @Nested
    @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
    @DisplayName("AZURE_TENANT_ID=common: any organization and personal accounts")
    class Common {

        @Value("${local.server.port}")
        int port;

        @DynamicPropertySource
        static void properties(DynamicPropertyRegistry registry) {
            configure(registry, "common");
        }

        @BeforeEach
        void clear() {
            USERS_SERVICE.clear();
        }

        @Test
        @DisplayName("A user of another organization is accepted without being invited")
        void otherOrganizationIsAccepted() throws Exception {
            assertEquals(200, get(port, ENTRA.userTokenOfTenant("user-escuela", OTHER_TENANT)));
            assertEquals(List.of("GET " + HISTORY), USERS_SERVICE.requests());
        }

        @Test
        @DisplayName("The home tenant and personal Microsoft accounts are accepted")
        void homeTenantAndPersonalAccountsAreAccepted() throws Exception {
            assertEquals(200, get(port, ENTRA.userToken("user-ana")));
            assertEquals(200, get(port, ENTRA.userTokenOfTenant("user-personal", PERSONAL)));
        }

        @Test
        @DisplayName("Invalid tokens are still refused: expired, forged, other audience, foreign or mismatched issuer")
        void invalidTokensAreStillRefused() throws Exception {
            assertEquals(401, get(port, ENTRA.userToken("x", c -> c
                    .issuer("https://login.microsoftonline.com/" + OTHER_TENANT + "/v2.0").claim("tid", OTHER_TENANT)
                    .issueTime(new java.util.Date(System.currentTimeMillis() - 7_200_000))
                    .expirationTime(new java.util.Date(System.currentTimeMillis() - 3_600_000)))));
            assertEquals(401, get(port, ENTRA.forgedUserToken("x")));
            assertEquals(401, get(port, ENTRA.userTokenForAudience("x", "another-api")));
            assertEquals(401, get(port, ENTRA.userToken("x", c -> c.issuer("https://evil.example/v2.0"))));
            // The issuer names one tenant, the tid claim another.
            assertEquals(401, get(port, ENTRA.userToken("x", c -> c.claim("tid", OTHER_TENANT))));
            assertTrue(USERS_SERVICE.requests().isEmpty(), "a refused token reached users-service");
        }
    }

    @Nested
    @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
    @DisplayName("AZURE_TENANT_ID=organizations: any organization, no personal accounts")
    class Organizations {

        @Value("${local.server.port}")
        int port;

        @DynamicPropertySource
        static void properties(DynamicPropertyRegistry registry) {
            configure(registry, "organizations");
        }

        @Test
        @DisplayName("Another organization is accepted, a personal account refused")
        void personalAccountsAreRefused() throws Exception {
            assertEquals(200, get(port, ENTRA.userTokenOfTenant("user-escuela", OTHER_TENANT)));
            assertEquals(401, get(port, ENTRA.userTokenOfTenant("user-personal", PERSONAL)));
        }
    }
}
