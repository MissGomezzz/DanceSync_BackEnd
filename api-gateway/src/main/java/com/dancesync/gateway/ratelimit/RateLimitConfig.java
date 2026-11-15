package com.dancesync.gateway.ratelimit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.util.StringUtils;

/** Where the gateway keeps its token buckets (SEG-3): Redis when {@code REDIS_URL} is set, memory otherwise. */
@Configuration
@EnableConfigurationProperties(RateLimitProperties.class)
public class RateLimitConfig {

    private static final Logger log = LoggerFactory.getLogger(RateLimitConfig.class);

    @Bean
    TokenBucketStore tokenBucketStore(RateLimitProperties properties) {
        if (!properties.enabled()) log.warn("HTTP rate limit disabled (dancesync.rate-limit.enabled=false)");
        if (StringUtils.hasText(properties.redisUrl())) {
            log.info("HTTP rate limit buckets in Redis");
            return new RedisTokenBucketStore(properties.redisUrl().trim());
        }
        log.info("HTTP rate limit buckets in memory (set REDIS_URL to share them between gateway instances)");
        return new InMemoryTokenBucketStore();
    }
}
