package com.dancesync.gateway.ratelimit;

import reactor.core.publisher.Mono;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

/** Token buckets in this gateway instance's memory: for local runs and tests, or when there is no Redis. */
public final class InMemoryTokenBucketStore implements TokenBucketStore {

    /** Buckets untouched for this long are forgotten (a full bucket and a missing one behave the same). */
    private static final long IDLE_MS = 10 * 60 * 1000;
    private static final long SWEEP_EVERY = 10_000;

    private final Map<String, Bucket> buckets = new ConcurrentHashMap<>();
    private final AtomicLong calls = new AtomicLong();
    private final LongSupplier nowMillis;

    public InMemoryTokenBucketStore() {
        this(System::currentTimeMillis);
    }

    public InMemoryTokenBucketStore(LongSupplier nowMillis) {
        this.nowMillis = nowMillis;
    }

    @Override
    public Mono<Long> take(String key, double perSecond, int burst) {
        long now = nowMillis.getAsLong();
        if (calls.incrementAndGet() % SWEEP_EVERY == 0) {
            buckets.values().removeIf(bucket -> bucket.idleSince(now) > IDLE_MS);
        }
        Bucket bucket = buckets.computeIfAbsent(key, k -> new Bucket(burst, now));
        return Mono.just(bucket.take(now, perSecond, burst));
    }

    private static final class Bucket {
        private double tokens;
        private long updatedAt;

        Bucket(int burst, long now) {
            this.tokens = burst;
            this.updatedAt = now;
        }

        synchronized long take(long now, double perSecond, int burst) {
            long elapsed = Math.max(0, now - updatedAt);
            updatedAt = Math.max(updatedAt, now);
            tokens = Math.min(burst, tokens + elapsed * perSecond / 1000.0);
            if (tokens >= 1) {
                tokens -= 1;
                return 0;
            }
            return (long) Math.ceil((1 - tokens) * 1000.0 / perSecond);
        }

        synchronized long idleSince(long now) {
            return now - updatedAt;
        }
    }
}
