package com.dancesync.gateway.ratelimit;

import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisURI;
import io.lettuce.core.ScriptOutputType;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.codec.StringCodec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Token buckets in Redis (SEG-3), shared by every gateway instance. Each take
 * is one Lua script, atomic inside Redis, using Redis' own clock so instances
 * with different clocks agree.
 *
 * <p>Fails open: if Redis is unreachable or slow the request goes on and the
 * error is logged (at most once a minute). An outage of the limiter must not
 * become an outage of the gateway.
 */
public final class RedisTokenBucketStore implements TokenBucketStore, AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(RedisTokenBucketStore.class);

    /** KEYS[1] bucket; ARGV[1] tokens per second; ARGV[2] burst. Returns 0 (allowed) or ms to wait. */
    static final String SCRIPT = """
            local key = KEYS[1]
            local rate = tonumber(ARGV[1])
            local burst = tonumber(ARGV[2])
            local time = redis.call('TIME')
            local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
            local state = redis.call('HMGET', key, 'tokens', 'ts')
            local tokens = tonumber(state[1])
            local ts = tonumber(state[2])
            if tokens == nil or ts == nil then
              tokens = burst
              ts = now
            end
            tokens = math.min(burst, tokens + math.max(0, now - ts) * rate / 1000)
            local wait = 0
            if tokens >= 1 then
              tokens = tokens - 1
            else
              wait = math.ceil((1 - tokens) * 1000 / rate)
            end
            redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
            redis.call('PEXPIRE', key, math.ceil(burst * 1000 / rate) + 1000)
            return wait
            """;

    private static final Duration TIMEOUT = Duration.ofMillis(250);
    private static final long ERROR_LOG_INTERVAL_MS = 60_000;

    private final RedisClient client;
    private final String prefix;
    private final Mono<StatefulRedisConnection<String, String>> connection;
    private final AtomicLong lastErrorLoggedAt = new AtomicLong(Long.MIN_VALUE / 2);

    public RedisTokenBucketStore(String redisUrl) {
        this(redisUrl, "ratelimit:");
    }

    public RedisTokenBucketStore(String redisUrl, String prefix) {
        this.client = RedisClient.create();
        this.prefix = prefix;
        RedisURI uri = RedisURI.create(redisUrl);
        // Connects on first use; a failed attempt is not cached, so the next request tries again.
        this.connection = Mono.fromCompletionStage(() -> client.connectAsync(StringCodec.UTF8, uri))
                .cache(connected -> Duration.ofDays(3650), error -> Duration.ZERO, () -> Duration.ZERO);
    }

    @Override
    public Mono<Long> take(String key, double perSecond, int burst) {
        return connection
                .flatMap(redis -> Flux.from(redis.reactive().<Long>eval(SCRIPT, ScriptOutputType.INTEGER,
                        new String[] {prefix + key}, Double.toString(perSecond), Integer.toString(burst))).next())
                .timeout(TIMEOUT)
                .defaultIfEmpty(0L)
                .onErrorResume(error -> {
                    logThrottled(error);
                    return Mono.just(0L);
                });
    }

    private void logThrottled(Throwable error) {
        long now = System.currentTimeMillis();
        long last = lastErrorLoggedAt.get();
        if (now - last >= ERROR_LOG_INTERVAL_MS && lastErrorLoggedAt.compareAndSet(last, now)) {
            log.error("Rate limit store unavailable; letting requests through: {}", error.toString());
        }
    }

    @Override
    public void close() {
        client.shutdown();
    }
}
