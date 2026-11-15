package com.dancesync.users.infrastructure.audit;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Guards the audit endpoints (SEG-2) with the shared internal secret {@code X-Internal-Token}:
 * <ul>
 *   <li>{@code /internal/audit/**}: the api-gateway and battle-service send their batches. Without
 *       the secret anyone inside the network could write forged records into the log.</li>
 *   <li>{@code /api/admin/**}: only reachable through the gateway, which checks that the caller is
 *       the admin (ROLE_ADMIN) and then adds the secret. A request that reaches users-service
 *       directly, without it, gets nothing.</li>
 * </ul>
 * The gateway removes any {@code X-Internal-Token} a client sends. Without a configured secret
 * both paths are refused (fail closed).
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
public class InternalTokenFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Internal-Token";

    private static final Logger log = LoggerFactory.getLogger(InternalTokenFilter.class);

    private final byte[] expected;

    /** Read as a plain property (not AuditProperties) so web slices without the audit wiring still load. */
    public InternalTokenFilter(@Value("${dancesync.audit.internal-token:}") String internalToken) {
        this.expected = internalToken.trim().getBytes(StandardCharsets.UTF_8);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return !(path.startsWith("/internal/") || path.startsWith("/api/admin/") || path.equals("/api/admin"));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String received = request.getHeader(HEADER);
        boolean valid = expected.length > 0 && received != null
                && MessageDigest.isEqual(expected, received.getBytes(StandardCharsets.UTF_8));
        if (valid) {
            chain.doFilter(request, response);
            return;
        }
        log.atWarn().addKeyValue("event", "internal.rejected").addKeyValue("path", request.getRequestURI())
                .addKeyValue("reason", expected.length == 0 ? "not_configured" : received == null ? "missing" : "invalid")
                .log("Internal call refused");
        response.setStatus(expected.length == 0 ? HttpServletResponse.SC_SERVICE_UNAVAILABLE : HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.getWriter().write("{\"error\":\"This endpoint is internal\"}");
    }
}
