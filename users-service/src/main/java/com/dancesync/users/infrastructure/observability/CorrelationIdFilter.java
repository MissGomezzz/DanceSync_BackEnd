package com.dancesync.users.infrastructure.observability;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;

import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Correlation id of every request (OBS-1). Reuses the {@code X-Correlation-Id} set by the
 * api-gateway or by battle-service (the PUT of a finished match), or generates one for
 * traffic that reaches the service directly. It goes into the MDC as {@code correlationId},
 * so every structured log line written while handling the request carries it, is echoed in
 * the response, and the request ends with one access log line.
 *
 * <p>A value that is not a plain id is replaced, so nothing a client sends can be injected
 * into the logs (same rule as the gateway and battle-service).
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CorrelationIdFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Correlation-Id";
    public static final String MDC_KEY = "correlationId";

    private static final Pattern VALID = Pattern.compile("[A-Za-z0-9._-]{1,64}");
    private static final Logger log = LoggerFactory.getLogger(CorrelationIdFilter.class);

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String correlationId = correlationIdFrom(request.getHeader(HEADER));
        long startedAt = System.nanoTime();
        MDC.put(MDC_KEY, correlationId);
        response.setHeader(HEADER, correlationId);
        try {
            chain.doFilter(request, response);
        } finally {
            // The query string, headers and body are never logged. Health probes poll every few
            // seconds: debug, unless they fail.
            boolean probe = request.getRequestURI().startsWith("/actuator/") && response.getStatus() < 400;
            (probe ? log.atDebug() : log.atInfo())
                    .addKeyValue("method", request.getMethod())
                    .addKeyValue("route", routeOf(request))
                    .addKeyValue("path", request.getRequestURI())
                    .addKeyValue("status", response.getStatus())
                    .addKeyValue("durationMs", (System.nanoTime() - startedAt) / 1_000_000.0)
                    .log("HTTP request");
            MDC.remove(MDC_KEY);
        }
    }

    /** The incoming id when it is a plain id, a new UUID otherwise. */
    static String correlationIdFrom(String header) {
        return header != null && VALID.matcher(header).matches() ? header : UUID.randomUUID().toString();
    }

    /** The matched route template (e.g. /api/matches/{id}), or "unmatched". */
    private static String routeOf(HttpServletRequest request) {
        Object pattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
        return pattern != null ? pattern.toString() : "unmatched";
    }
}
