package com.dancesync.gateway.ratelimit;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Runs only when TEST_REDIS_URL points to a disposable Redis (e.g. docker run -p 6379:6379 redis:7). */
@EnabledIfEnvironmentVariable(named = "TEST_REDIS_URL", matches = ".+")
class RedisTokenBucketStoreTests {

    private final RedisTokenBucketStore store =
            new RedisTokenBucketStore(System.getenv("TEST_REDIS_URL"), "test:ratelimit:" + UUID.randomUUID() + ":");

    @AfterEach
    void close() {
        store.close();
    }

    private long take(String key, double perSecond, int burst) {
        return store.take(key, perSecond, burst).block();
    }

    @Test
    @DisplayName("Redis: a full bucket lets the burst through and then says how long to wait")
    void burstThenWait() {
        for (int i = 0; i < 5; i++) assertEquals(0, take("a", 1, 5), "request " + (i + 1));
        long wait = take("a", 1, 5);
        assertTrue(wait > 0 && wait <= 1000, "wait " + wait);
    }

    @Test
    @DisplayName("Redis: tokens come back with time")
    void refills() throws InterruptedException {
        for (int i = 0; i < 2; i++) take("b", 10, 2);
        assertTrue(take("b", 10, 2) > 0);
        Thread.sleep(150);
        assertEquals(0, take("b", 10, 2));
    }

    @Test
    @DisplayName("Redis: each key has its own bucket")
    void independentKeys() {
        for (int i = 0; i < 2; i++) take("x", 1, 2);
        assertTrue(take("x", 1, 2) > 0);
        assertEquals(0, take("y", 1, 2));
    }
}
