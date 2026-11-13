package com.dancesync.gateway.security;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Gives every request a correlation id before anything else runs (security
 * included): the one the caller sent in {@code X-Correlation-Id} when it is a
 * plain id, a new one otherwise. It is echoed in the response, forwarded to
 * the downstream service and written in the audit log, so a refused attempt
 * can be followed across the gateway and battle-service.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CorrelationIdFilter implements WebFilter {

    public static final String HEADER = "X-Correlation-Id";
    static final String ATTRIBUTE = CorrelationIdFilter.class.getName() + ".correlationId";

    /** Anything else is replaced, so a client cannot inject text into the log. */
    private static final Pattern VALID = Pattern.compile("[A-Za-z0-9._-]{1,64}");

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        String received = exchange.getRequest().getHeaders().getFirst(HEADER);
        String correlationId = received != null && VALID.matcher(received).matches()
                ? received
                : UUID.randomUUID().toString();
        exchange.getAttributes().put(ATTRIBUTE, correlationId);
        exchange.getResponse().getHeaders().set(HEADER, correlationId);
        ServerHttpRequest request = exchange.getRequest().mutate()
                .headers(headers -> headers.set(HEADER, correlationId))
                .build();
        return chain.filter(exchange.mutate().request(request).build());
    }

    /** The correlation id of the exchange (always present once the filter ran). */
    static String of(ServerWebExchange exchange) {
        String correlationId = exchange.getAttribute(ATTRIBUTE);
        return correlationId != null ? correlationId : UUID.randomUUID().toString();
    }
}
