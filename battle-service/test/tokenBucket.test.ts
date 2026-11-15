import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TokenBucket } from "../src/infrastructure/abuse/TokenBucket.js";

/** A clock the test moves by hand. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("TokenBucket (SEG-3)", () => {
  it("lets a full burst through at once and refuses the next event", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(20, 40, clock.now);
    for (let i = 0; i < 40; i += 1) assert.equal(bucket.take().allowed, true, `event ${i + 1} of the burst`);
    const refused = bucket.take();
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfterMs, 50, "at 20 per second the next token is 50 ms away");
  });

  it("refills at the sustained rate", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(20, 40, clock.now);
    for (let i = 0; i < 40; i += 1) bucket.take();
    clock.advance(49);
    assert.equal(bucket.take().allowed, false, "49 ms is not yet one token");
    clock.advance(1);
    assert.equal(bucket.take().allowed, true, "50 ms is exactly one token");
    clock.advance(500);
    let allowed = 0;
    while (bucket.take().allowed) allowed += 1;
    assert.equal(allowed, 10, "half a second is ten tokens");
  });

  it("never accumulates more than its capacity", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(20, 40, clock.now);
    clock.advance(60_000);
    assert.equal(bucket.available(), 40);
  });

  it("accepts a client that stays at the sustained rate forever", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(20, 40, clock.now);
    for (let i = 0; i < 10_000; i += 1) {
      assert.equal(bucket.take().allowed, true, `event ${i + 1}`);
      clock.advance(50);
    }
  });

  it("refuses most of a flood: 200 events per second keep about 20 per second", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(20, 40, clock.now);
    let allowed = 0;
    for (let i = 0; i < 2_000; i += 1) {
      if (bucket.take().allowed) allowed += 1;
      clock.advance(5); // 200 per second for 10 s
    }
    assert.ok(allowed >= 40 + 199 && allowed <= 40 + 201, `allowed ${allowed}: the burst plus 20 per second`);
  });

  it("does not go backwards when the clock does", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(20, 40, clock.now);
    for (let i = 0; i < 40; i += 1) bucket.take();
    clock.advance(-5_000);
    assert.equal(bucket.take().allowed, false);
  });

  it("refuses settings that would let nothing through", () => {
    assert.throws(() => new TokenBucket(0, 40), /ratePerSecond/);
    assert.throws(() => new TokenBucket(20, 0), /capacity/);
  });
});
