package com.dancesync.gateway.ratelimit;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * HTTP rate limit of the gateway (SEG-3), bound from {@code dancesync.rate-limit}.
 * Each policy is a token bucket per client address: {@code burst} requests at
 * once, refilled at {@code perSecond}.
 */
@ConfigurationProperties("dancesync.rate-limit")
public record RateLimitProperties(
        @DefaultValue("true") boolean enabled,
        @DefaultValue("0") int trustedProxyHops,
        @DefaultValue("") String redisUrl,
        @DefaultValue Policy roomCreate,
        @DefaultValue Policy guestToken,
        @DefaultValue Policy socketHandshake,
        @DefaultValue Policy socketPolling,
        @DefaultValue Policy other) {

    /** A token bucket: {@code burst} requests at once, refilled at {@code perSecond}. */
    public record Policy(@DefaultValue("20") double perSecond, @DefaultValue("40") int burst) {
    }
}
