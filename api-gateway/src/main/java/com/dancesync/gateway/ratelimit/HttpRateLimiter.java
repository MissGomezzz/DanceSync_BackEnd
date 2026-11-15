package com.dancesync.gateway.ratelimit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * SEG-3 at the gateway: a token bucket per client address and per kind of
 * request, answered {@code 429 Too Many Requests} with {@code Retry-After} when
 * empty.
 *
 * <p>It runs inside the security filter chain, after CORS and before
 * authentication (see {@code SecurityConfig}): a refusal carries the CORS
 * headers, so the browser can read it, and a flood of requests with forged
 * tokens is cut before any signature is checked or any audit line written.
 * It is deliberately not a {@code WebFilter} bean, which WebFlux would run a
 * second time outside the security chain.
 *
 * <p>Policies: creating a room, asking for a guest token, opening a Socket.IO
 * connection (handshake), the requests of an open long-polling session, and
 * everything else. Preflight requests and health checks are never limited.
 */
@Component
public class HttpRateLimiter {

    static final String ROOM_CREATE = "room-create";
    static final String GUEST_TOKEN = "guest-token";
    static final String SOCKET_HANDSHAKE = "socket-handshake";
    static final String SOCKET_POLLING = "socket-polling";
    static final String OTHER = "other";

    /** Same logger as the authentication audit (SEG-1), so both trails can be read together. */
    static final String AUDIT_LOGGER = "dancesync.security.audit";
    private static final Logger audit = LoggerFactory.getLogger(AUDIT_LOGGER);

    private static final String CORRELATION_HEADER = "X-Correlation-Id";
    private static final Pattern GUEST_TOKEN_PATH = Pattern.compile("/api/rooms/[^/]+/guest-token/?");
    private static final long LOG_INTERVAL_MS = 1000;
    private static final int MAX_TRACKED_SOURCES = 10_000;

    private final RateLimitProperties properties;
    private final TokenBucketStore store;
    /** "policy ip" -> {last line written at, refusals since}: at most one audit line per second and source. */
    private final Map<String, long[]> logged = new ConcurrentHashMap<>();

    public HttpRateLimiter(RateLimitProperties properties, TokenBucketStore store) {
        this.properties = properties;
        this.store = store;
    }

    /** Has the shape of {@code WebFilter#filter}, so the security chain can take it as {@code rateLimiter::filter}. */
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        if (!properties.enabled()) return chain.filter(exchange);
        ServerHttpRequest request = exchange.getRequest();
        String policyName = policyOf(request);
        if (policyName == null) return chain.filter(exchange);

        RateLimitProperties.Policy policy = policy(policyName);
        String ip = ClientAddress.resolve(request.getRemoteAddress(),
                request.getHeaders().get("X-Forwarded-For"), properties.trustedProxyHops());
        return store.take(policyName + ":" + ip, policy.perSecond(), policy.burst())
                .flatMap(waitMs -> waitMs <= 0 ? chain.filter(exchange) : refuse(exchange, policyName, ip, waitMs));
    }

    /** The policy of a request, or null for requests that are never limited. */
    static String policyOf(ServerHttpRequest request) {
        HttpMethod method = request.getMethod();
        String path = request.getPath().pathWithinApplication().value();
        if (HttpMethod.OPTIONS.equals(method)) return null;
        if (path.equals("/actuator/health") || path.startsWith("/actuator/health/") || path.equals("/api/battles/health")) {
            return null;
        }
        if (HttpMethod.POST.equals(method) && (path.equals("/api/rooms") || path.equals("/api/rooms/"))) return ROOM_CREATE;
        if (HttpMethod.POST.equals(method) && GUEST_TOKEN_PATH.matcher(path).matches()) return GUEST_TOKEN;
        if (path.equals("/socket.io") || path.startsWith("/socket.io/")) {
            // A connection starts without a session id (WebSocket first, or the first long-polling request).
            return request.getQueryParams().getFirst("sid") == null ? SOCKET_HANDSHAKE : SOCKET_POLLING;
        }
        return OTHER;
    }

    private RateLimitProperties.Policy policy(String name) {
        return switch (name) {
            case ROOM_CREATE -> properties.roomCreate();
            case GUEST_TOKEN -> properties.guestToken();
            case SOCKET_HANDSHAKE -> properties.socketHandshake();
            case SOCKET_POLLING -> properties.socketPolling();
            default -> properties.other();
        };
    }

    private Mono<Void> refuse(ServerWebExchange exchange, String policy, String ip, long waitMs) {
        ServerHttpRequest request = exchange.getRequest();
        String correlationId = request.getHeaders().getFirst(CORRELATION_HEADER);
        logRefusal(policy, ip, correlationId, request);

        ServerHttpResponse response = exchange.getResponse();
        response.setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
        response.getHeaders().set(HttpHeaders.RETRY_AFTER, Long.toString(Math.max(1, (waitMs + 999) / 1000)));
        response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        byte[] body = ("{\"error\":\"Too many requests\",\"code\":\"RATE_LIMITED\",\"retryAfterMs\":" + waitMs
                + ",\"correlationId\":\"" + (correlationId == null ? "" : correlationId) + "\"}")
                .getBytes(StandardCharsets.UTF_8);
        return response.writeWith(Mono.just(response.bufferFactory().wrap(body)));
    }

    /** One audit line per second and source, with how many requests were refused since the previous one. */
    private void logRefusal(String policy, String ip, String correlationId, ServerHttpRequest request) {
        long now = System.currentTimeMillis();
        if (logged.size() > MAX_TRACKED_SOURCES) logged.clear();
        long[] state = logged.computeIfAbsent(policy + " " + ip, k -> new long[] {Long.MIN_VALUE / 2, 0});
        long refused;
        synchronized (state) {
            state[1] += 1;
            if (now - state[0] < LOG_INTERVAL_MS) return;
            refused = state[1];
            state[0] = now;
            state[1] = 0;
        }
        audit.warn("{\"event\":\"abuse.rate_limited\",\"channel\":\"http\",\"policy\":\"{}\",\"ip\":\"{}\","
                        + "\"refused\":{},\"correlationId\":\"{}\",\"method\":\"{}\",\"path\":\"{}\"}",
                policy, escape(ip), refused, correlationId == null ? "" : correlationId,
                request.getMethod().name(), escape(request.getPath().value()));
    }

    /** Keeps a value a safe JSON string: quotes, backslashes and control characters are escaped. */
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
