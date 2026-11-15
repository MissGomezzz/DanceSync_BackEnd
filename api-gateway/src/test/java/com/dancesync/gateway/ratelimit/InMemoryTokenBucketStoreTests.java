package com.dancesync.gateway.ratelimit;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class InMemoryTokenBucketStoreTests {

    private final AtomicLong now = new AtomicLong(1_000_000);
    private final InMemoryTokenBucketStore store = new InMemoryTokenBucketStore(now::get);

    private long take(String key, double perSecond, int burst) {
        return store.take(key, perSecond, burst).block();
    }

    @Test
    @DisplayName("A full bucket lets the burst through and then says how long to wait")
    void burstThenWait() {
        for (int i = 0; i < 10; i++) assertEquals(0, take("a", 1, 10), "request " + (i + 1));
        assertEquals(1000, take("a", 1, 10));
    }

    @Test
    @DisplayName("Tokens come back at the configured rate, also below one per second")
    void refills() {
        for (int i = 0; i < 2; i++) take("slow", 0.5, 2);
        assertEquals(2000, take("slow", 0.5, 2));
        now.addAndGet(1900);
        assertTrue(take("slow", 0.5, 2) > 0, "0.95 of a token is not a token");
        now.addAndGet(200);
        assertEquals(0, take("slow", 0.5, 2));
    }

    @Test
    @DisplayName("Each key has its own bucket")
    void independentKeys() {
        for (int i = 0; i < 3; i++) take("guest-token:198.51.100.1", 1, 3);
        assertTrue(take("guest-token:198.51.100.1", 1, 3) > 0);
        assertEquals(0, take("guest-token:198.51.100.2", 1, 3));
        assertEquals(0, take("room-create:198.51.100.1", 1, 3));
    }

    @Test
    @DisplayName("A bucket never holds more than its burst, and a clock going back does not add tokens")
    void capacityAndClock() {
        take("c", 1, 3);
        now.addAndGet(3_600_000);
        for (int i = 0; i < 3; i++) assertEquals(0, take("c", 1, 3));
        assertTrue(take("c", 1, 3) > 0);
        now.addAndGet(-60_000);
        assertTrue(take("c", 1, 3) > 0);
    }
}
