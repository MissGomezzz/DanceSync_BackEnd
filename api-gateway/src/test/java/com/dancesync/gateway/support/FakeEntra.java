package com.dancesync.gateway.support;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import java.util.function.Consumer;

/**
 * A stand-in for Microsoft Entra ID in the gateway tests: an RSA key pair
 * whose public half is served as a JWKS over HTTP, like the tenant's
 * discovery keys endpoint, and access tokens signed with it. The gateway under
 * test is configured exactly as in production, only pointing at this key set.
 * It also signs guest tokens like battle-service does.
 */
public final class FakeEntra {

    public static final String TENANT_ID = "11111111-1111-4111-8111-111111111111";
    public static final String CLIENT_ID = "22222222-2222-4222-8222-222222222222";
    public static final String ISSUER = "https://login.microsoftonline.com/" + TENANT_ID + "/v2.0";
    public static final String GUEST_SECRET = "test-guest-secret-of-at-least-32-bytes!!";
    public static final String GUEST_ISSUER = "dancesync-battle-service";
    public static final String GUEST_AUDIENCE = "dancesync-guest";

    private final RSAKey tenantKey;
    private final RSAKey attackerKey;
    private final HttpServer jwks;

    public FakeEntra() {
        try {
            tenantKey = new RSAKeyGenerator(2048).keyID("test-key-1").generate();
            // Same key id, another key: what an attacker who cannot sign as the tenant would use.
            attackerKey = new RSAKeyGenerator(2048).keyID("test-key-1").generate();
            byte[] keySet = new JWKSet(tenantKey.toPublicJWK()).toString().getBytes(StandardCharsets.UTF_8);
            jwks = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
            jwks.createContext("/", exchange -> {
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, keySet.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(keySet);
                }
            });
            jwks.start();
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public String jwkSetUri() {
        return "http://localhost:" + jwks.getAddress().getPort() + "/discovery/v2.0/keys";
    }

    public void stop() {
        jwks.stop(0);
    }

    /** A valid access token of a registered user, as Entra ID v2.0 issues it for the API. */
    public String userToken(String oid) {
        return userToken(oid, claims -> { });
    }

    /** A user token with some claims changed before signing (expiry, audience, issuer...). */
    public String userToken(String oid, Consumer<JWTClaimsSet.Builder> customizer) {
        return sign(tenantKey, userClaims(oid, customizer));
    }

    /** Issued two hours ago for one hour: a genuine token that is simply too old. */
    public String expiredUserToken(String oid) {
        return userToken(oid, FakeEntra::expireAnHourAgo);
    }

    public String expiredGuestToken(String roomCode) {
        return guestToken(roomCode, GUEST_SECRET, FakeEntra::expireAnHourAgo);
    }

    private static void expireAnHourAgo(JWTClaimsSet.Builder claims) {
        Instant now = Instant.now();
        claims.issueTime(Date.from(now.minusSeconds(7200))).expirationTime(Date.from(now.minusSeconds(3600)));
    }

    public String userTokenForAudience(String oid, String audience) {
        return userToken(oid, claims -> claims.audience(audience));
    }

    /** Every claim is right, but the signature is not the tenant's. */
    public String forgedUserToken(String oid) {
        return sign(attackerKey, userClaims(oid, claims -> { }));
    }

    /** A guest token as battle-service signs it, valid only for {@code roomCode}. */
    public String guestToken(String roomCode) {
        return guestToken(roomCode, GUEST_SECRET, claims -> { });
    }

    public String guestToken(String roomCode, String secret, Consumer<JWTClaimsSet.Builder> customizer) {
        Instant now = Instant.now();
        JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder()
                .issuer(GUEST_ISSUER)
                .audience(GUEST_AUDIENCE)
                .subject("guest-0b9c7f0e-6f7e-4c59-9d5d-2f9f6a1c3e11")
                .claim("name", "Invitado")
                .claim("room", roomCode)
                .claim("scope", "guest")
                .issueTime(Date.from(now.minusSeconds(60)))
                .expirationTime(Date.from(now.plusSeconds(600)));
        customizer.accept(claims);
        try {
            SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims.build());
            jwt.sign(new MACSigner(secret.getBytes(StandardCharsets.UTF_8)));
            return jwt.serialize();
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        }
    }

    /** A valid token whose payload was edited afterwards; the signature no longer matches. */
    public static String tamperedPayload(String token, String claim, String newValue) {
        String[] parts = token.split("\\.");
        String payload = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
        String edited = payload.replaceFirst("\"" + claim + "\":\"[^\"]*\"", "\"" + claim + "\":\"" + newValue + "\"");
        if (edited.equals(payload)) throw new IllegalArgumentException("Claim " + claim + " not found");
        return parts[0] + "." + encode(edited) + "." + parts[2];
    }

    /** The same claims re-encoded as an unsigned token ("alg: none"). */
    public static String unsigned(String token) {
        return encode("{\"alg\":\"none\",\"typ\":\"JWT\"}") + "." + token.split("\\.")[1] + ".";
    }

    private static String encode(String json) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(json.getBytes(StandardCharsets.UTF_8));
    }

    private static JWTClaimsSet userClaims(String oid, Consumer<JWTClaimsSet.Builder> customizer) {
        Instant now = Instant.now();
        JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder()
                .issuer(ISSUER)
                .audience(List.of(CLIENT_ID))
                .subject("sub-of-" + oid)
                .claim("oid", oid)
                .claim("name", "Ana")
                .claim("tid", TENANT_ID)
                .claim("scp", "access_as_user")
                .claim("ver", "2.0")
                .issueTime(Date.from(now.minusSeconds(60)))
                .expirationTime(Date.from(now.plusSeconds(3600)));
        customizer.accept(claims);
        return claims.build();
    }

    private static String sign(RSAKey key, JWTClaimsSet claims) {
        try {
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(key.getKeyID()).build(), claims);
            jwt.sign(new RSASSASigner(key));
            return jwt.serialize();
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        }
    }
}
