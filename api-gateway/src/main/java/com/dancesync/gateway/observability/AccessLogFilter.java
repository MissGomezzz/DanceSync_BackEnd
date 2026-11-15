package com.dancesync.gateway.observability;

import com.dancesync.gateway.security.CorrelationIdFilter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cloud.gateway.route.Route;
import org.springframework.cloud.gateway.support.ServerWebExchangeUtils;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatusCode;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * One access log line per request (OBS-1): correlation id, method, path, route, status and
 * duration, as structured key-value pairs of one JSON line (there is no MDC in a reactive
 * pipeline, so the fields are put on the line itself).
 *
 * <p>It is a {@code WebFilter} right after {@link CorrelationIdFilter}, not a gateway
 * {@code GlobalFilter}: a global filter only sees routed requests, while this one also
 * logs the requests refused by the rate limiter (429) or the security chain (401/403) and
 * the gateway's own endpoints. The query string, headers and body are never logged.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
public class AccessLogFilter implements WebFilter {

    private static final Logger log = LoggerFactory.getLogger(AccessLogFilter.class);

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        long startedAt = System.nanoTime();
        return chain.filter(exchange).doFinally(signal -> log(exchange, startedAt));
    }

    private static void log(ServerWebExchange exchange, long startedAt) {
        HttpStatusCode status = exchange.getResponse().getStatusCode();
        Route route = exchange.getAttribute(ServerWebExchangeUtils.GATEWAY_ROUTE_ATTR);
        String path = exchange.getRequest().getPath().value();
        // Health probes and Prometheus scrapes poll every few seconds: debug, unless they fail.
        boolean probe = path.startsWith("/actuator/") && status != null && status.value() < 400;
        (probe ? log.atDebug() : log.atInfo())
                // Set (and sanitized) by CorrelationIdFilter on the request this filter receives.
                .addKeyValue("correlationId", exchange.getRequest().getHeaders().getFirst(CorrelationIdFilter.HEADER))
                .addKeyValue("method", exchange.getRequest().getMethod().name())
                .addKeyValue("path", path)
                .addKeyValue("route", route != null ? route.getId() : "none")
                .addKeyValue("status", status != null ? status.value() : 0)
                .addKeyValue("durationMs", (System.nanoTime() - startedAt) / 1_000_000.0)
                .log("HTTP request");
    }
}
