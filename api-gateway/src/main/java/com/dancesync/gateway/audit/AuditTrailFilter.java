package com.dancesync.gateway.audit;

import com.dancesync.gateway.ratelimit.ClientAddress;
import com.dancesync.gateway.ratelimit.RateLimitProperties;
import com.dancesync.gateway.security.CorrelationIdFilter;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.ReactiveSecurityContextHolder;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

import java.net.InetAddress;
import java.time.Clock;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * SEG-2 at the gateway: one audit record per HTTP request to the backend, with the user (from the
 * validated token), the client address (behind the trusted proxies), the server's UTC time, the
 * browser (User-Agent), the action (method and path), the outcome and the correlation id. users-service
 * adds the region (GeoIP) and chains it.
 *
 * <p>It wraps the security chain (right after the correlation id and the access log), so it also
 * records the requests refused with 401, 403 or 429. The identity is left in an exchange attribute
 * by {@link #captureIdentity}, which runs inside the security chain after authentication. The token,
 * the query string, the other headers and the body are never recorded.
 *
 * <p>Not recorded: CORS preflights (the browser sends them on its own, they are not an action) and
 * the actuator probes of the platform. The record is taken when the response is committed, so a
 * WebSocket upgrade is recorded at the handshake, not when the connection ends hours later.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 2)
@EnableConfigurationProperties(AuditProperties.class)
public class AuditTrailFilter implements WebFilter {

    /** Exchange attribute where the security chain leaves why it refused the request. */
    public static final String REASON_ATTRIBUTE = AuditTrailFilter.class.getName() + ".reason";

    private final AuditShipper shipper;
    private final AuditProperties properties;
    private final RateLimitProperties rateLimit;
    private final Clock clock;
    private final String source;

    public AuditTrailFilter(AuditShipper shipper, AuditProperties properties, RateLimitProperties rateLimit) {
        this.shipper = shipper;
        this.properties = properties;
        this.rateLimit = rateLimit;
        this.clock = Clock.systemUTC();
        this.source = "api-gateway@" + hostname();
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        ServerHttpRequest request = exchange.getRequest();
        if (!properties.enabled() || request.getMethod() == HttpMethod.OPTIONS
                || request.getPath().value().startsWith("/actuator")) {
            return chain.filter(exchange);
        }
        Instant receivedAt = clock.instant();
        AtomicBoolean recorded = new AtomicBoolean();
        Runnable record = () -> {
            if (recorded.compareAndSet(false, true)) shipper.submit(entryOf(exchange, receivedAt));
        };
        exchange.getResponse().beforeCommit(() -> Mono.fromRunnable(record));
        // A request whose response is never committed (client gone, error before writing).
        return chain.filter(exchange).doFinally(signal -> record.run());
    }

    AuditEntry entryOf(ServerWebExchange exchange, Instant receivedAt) {
        ServerHttpRequest request = exchange.getRequest();
        HttpStatusCode statusCode = exchange.getResponse().getStatusCode();
        int status = statusCode == null ? 200 : statusCode.value();
        AuditIdentity identity = exchange.getAttribute(AuditIdentity.ATTRIBUTE);
        String path = request.getPath().value();
        return new AuditEntry(
                UUID.randomUUID(),
                receivedAt,
                source,
                "http",
                request.getMethod().name() + " " + path,
                path,
                outcomeOf(status),
                status,
                exchange.getAttribute(REASON_ATTRIBUTE),
                identity == null ? null : identity.userId(),
                identity == null ? "anonymous" : identity.kind(),
                identity == null ? null : identity.displayName(),
                ClientAddress.resolve(request.getRemoteAddress(), request.getHeaders().get("X-Forwarded-For"),
                        rateLimit.trustedProxyHops()),
                request.getHeaders().getFirst(HttpHeaders.USER_AGENT),
                // Set (and sanitized) by CorrelationIdFilter on the request this filter receives.
                request.getHeaders().getFirst(CorrelationIdFilter.HEADER),
                null);
    }

    static String outcomeOf(int status) {
        if (status == 401 || status == 403) return "rejected";
        if (status == 429) return "rate_limited";
        if (status >= 500) return "error";
        if (status >= 400) return "failed";
        return "ok";
    }

    /**
     * Runs inside the security chain, after authentication: copies who the validated token belongs
     * to into the exchange, where {@link AuditTrailFilter} (outside the chain) reads it.
     */
    public static Mono<Void> captureIdentity(ServerWebExchange exchange, WebFilterChain chain) {
        return ReactiveSecurityContextHolder.getContext()
                .map(SecurityContext::getAuthentication)
                .filter(Authentication::isAuthenticated)
                .doOnNext(authentication -> {
                    AuditIdentity identity = identityOf(authentication);
                    if (identity != null) exchange.getAttributes().put(AuditIdentity.ATTRIBUTE, identity);
                })
                .then(chain.filter(exchange));
    }

    private static AuditIdentity identityOf(Authentication authentication) {
        if (!(authentication instanceof JwtAuthenticationToken jwt)) return null;
        boolean guest = jwt.getAuthorities().stream().anyMatch(a -> "ROLE_GUEST".equals(a.getAuthority()));
        String name = jwt.getToken().getClaimAsString("name");
        if (name == null) name = jwt.getToken().getClaimAsString("preferred_username");
        return new AuditIdentity(jwt.getName(), guest ? "guest" : "user", name);
    }

    private static String hostname() {
        try {
            return InetAddress.getLocalHost().getHostName();
        } catch (Exception e) {
            return "unknown";
        }
    }
}
