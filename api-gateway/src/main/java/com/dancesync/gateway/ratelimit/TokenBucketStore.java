package com.dancesync.gateway.ratelimit;

import reactor.core.publisher.Mono;

/**
 * Token buckets by key (SEG-3). {@link #take} spends one token of the bucket
 * named {@code key}, creating it full ({@code burst} tokens) the first time.
 */
public interface TokenBucketStore {

    /** 0 when the request may go on; otherwise the milliseconds until the next token. */
    Mono<Long> take(String key, double perSecond, int burst);
}
