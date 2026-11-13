package com.dancesync.gateway.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.web.server.ServerAuthenticationEntryPoint;
import org.springframework.security.web.server.authorization.ServerAccessDeniedHandler;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Answers every refused request and keeps the audit trail (SEG-1): 401 when
 * there is no valid token, 403 when a valid token does not allow the action
 * (a guest outside its scope). Each refusal is one log line with the
 * correlation id, the method, the path and the reason. The token, the other
 * headers, the query string and the body are never logged, and the client
 * only gets a generic message: the precise reason stays in the log.
 */
@Component
public class AuthRejectionHandler implements ServerAuthenticationEntryPoint, ServerAccessDeniedHandler {

    /** Dedicated logger, so the audit trail can be routed or retained on its own. */
    static final String AUDIT_LOGGER = "dancesync.security.audit";

    private static final Logger audit = LoggerFactory.getLogger(AUDIT_LOGGER);

    @Override
    public Mono<Void> commence(ServerWebExchange exchange, AuthenticationException failure) {
        exchange.getResponse().getHeaders().set(HttpHeaders.WWW_AUTHENTICATE, "Bearer");
        return refuse(exchange, HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", reasonOf(exchange, failure),
                "A valid access token is required");
    }

    @Override
    public Mono<Void> handle(ServerWebExchange exchange, AccessDeniedException denied) {
        return refuse(exchange, HttpStatus.FORBIDDEN, "FORBIDDEN", "guest_out_of_scope",
                "This token does not allow this action");
    }

    private Mono<Void> refuse(ServerWebExchange exchange, HttpStatus status, String code, String reason,
                              String message) {
        String correlationId = CorrelationIdFilter.of(exchange);
        audit.warn("{\"event\":\"auth.rejected\",\"channel\":\"http\",\"code\":\"{}\",\"reason\":\"{}\","
                        + "\"correlationId\":\"{}\",\"method\":\"{}\",\"path\":\"{}\"}",
                code, reason, correlationId, exchange.getRequest().getMethod().name(),
                escape(exchange.getRequest().getPath().value()));

        ServerHttpResponse response = exchange.getResponse();
        response.setStatusCode(status);
        response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        byte[] body = ("{\"error\":\"" + message + "\",\"code\":\"" + code + "\",\"correlationId\":\""
                + correlationId + "\"}").getBytes(StandardCharsets.UTF_8);
        return response.writeWith(Mono.just(response.bufferFactory().wrap(body)));
    }

    /**
     * Why the token was refused, as a fixed category. The exception message is
     * only inspected, never logged: it describes the failed check, and keeping
     * to categories guarantees nothing taken from the token reaches the log.
     */
    private static String reasonOf(ServerWebExchange exchange, AuthenticationException failure) {
        if (!exchange.getRequest().getHeaders().containsHeader(HttpHeaders.AUTHORIZATION)) return "missing_token";
        if (!(failure instanceof OAuth2AuthenticationException)) return "missing_token";
        String message = String.valueOf(failure.getMessage()).toLowerCase(Locale.ROOT);
        if (message.contains("jwt expired")) return "expired_token";
        if (message.contains("aud claim")) return "wrong_audience";
        if (message.startsWith("invalid issuer") || message.contains("iss claim")) return "wrong_issuer";
        // Spring Security reports a signature that does not verify (or a key the issuer never
        // published) as a generic validation failure, and "alg: none" as an unsupported algorithm.
        if (message.contains("failed to validate the token") || message.contains("signature")
                || message.contains("algorithm")) {
            return "invalid_signature";
        }
        return "malformed_token";
    }

    /** Keeps the path a safe JSON string: quotes, backslashes and control characters are escaped. */
    private static String escape(String value) {
        StringBuilder escaped = new StringBuilder(value.length());
        for (char c : value.toCharArray()) {
            if (c == '"' || c == '\\') escaped.append('\\').append(c);
            else if (c < 0x20) escaped.append(String.format("\\u%04x", (int) c));
            else escaped.append(c);
        }
        return escaped.toString();
    }
}
