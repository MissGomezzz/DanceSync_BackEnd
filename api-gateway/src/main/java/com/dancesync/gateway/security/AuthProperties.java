package com.dancesync.gateway.security;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.StringUtils;

import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Authentication settings of the gateway (SEG-1), bound from {@code dancesync.auth}.
 */
@ConfigurationProperties("dancesync.auth")
public record AuthProperties(@DefaultValue Entra entra, @DefaultValue Guest guest, @DefaultValue Cors cors) {

    /** Smallest accepted HS256 secret: 32 bytes, the size of the hash. */
    static final int MIN_GUEST_SECRET_BYTES = 32;

    /** Microsoft Entra ID: who issues the access tokens of registered users. */
    public record Entra(String tenantId, String clientId, List<String> audiences, String issuerUri, String jwkSetUri) {

        private String authority() {
            return "https://login.microsoftonline.com/" + tenantId.trim();
        }

        /**
         * True when the tenant is "common" (any organization and personal Microsoft
         * accounts) or "organizations" (any organization): a multi-tenant application,
         * like the MSAL authority of the same name.
         */
        public boolean anyTenant() {
            if (StringUtils.hasText(issuerUri) || !StringUtils.hasText(tenantId)) return false;
            String tenancy = tenantId.trim().toLowerCase(java.util.Locale.ROOT);
            return tenancy.equals("common") || tenancy.equals("organizations");
        }

        /** With {@link #anyTenant()}: whether personal Microsoft accounts are accepted too ("common"). */
        public boolean allowsPersonalAccounts() {
            return anyTenant() && tenantId.trim().equalsIgnoreCase("common");
        }

        /** The v2.0 issuer of the tenant, unless overridden; null for a multi-tenant application. */
        public String resolvedIssuer() {
            if (StringUtils.hasText(issuerUri)) return issuerUri.trim();
            return StringUtils.hasText(tenantId) && !anyTenant() ? authority() + "/v2.0" : null;
        }

        /** Where the tenant publishes its signing keys, unless overridden. */
        public String resolvedJwkSetUri() {
            if (StringUtils.hasText(jwkSetUri)) return jwkSetUri.trim();
            return StringUtils.hasText(tenantId) ? authority() + "/discovery/v2.0/keys" : null;
        }

        /** Accepted {@code aud} values: the configured list, or the client id. */
        public List<String> resolvedAudiences() {
            List<String> configured = audiences == null
                    ? List.of()
                    : audiences.stream().filter(StringUtils::hasText).map(String::trim).toList();
            if (!configured.isEmpty()) return configured;
            return StringUtils.hasText(clientId) ? List.of(clientId.trim()) : List.of();
        }

        public boolean configured() {
            return (resolvedIssuer() != null || anyTenant()) && resolvedJwkSetUri() != null
                    && !resolvedAudiences().isEmpty();
        }
    }

    /** Guest tokens, signed by battle-service with a secret both services share. */
    public record Guest(String secret,
                        @DefaultValue("dancesync-battle-service") String issuer,
                        @DefaultValue("dancesync-guest") String audience) {

        public boolean configured() {
            return StringUtils.hasText(secret);
        }

        public byte[] secretBytes() {
            byte[] bytes = secret.getBytes(StandardCharsets.UTF_8);
            if (bytes.length < MIN_GUEST_SECRET_BYTES) {
                throw new IllegalStateException(
                        "GUEST_TOKEN_SECRET must be at least " + MIN_GUEST_SECRET_BYTES + " bytes long");
            }
            return bytes;
        }
    }

    /** The frontend origin, also allowed on the 401 / 403 answers of the gateway itself. */
    public record Cors(@DefaultValue("http://localhost:5173") String allowedOrigin) {
    }
}
