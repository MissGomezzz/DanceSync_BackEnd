import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadAbuseConfig } from "../src/infrastructure/abuse/abuseConfig.js";

describe("abuse protection configuration (SEG-3)", () => {
  it("defaults to the scenario values", () => {
    assert.deepEqual(loadAbuseConfig({}), {
      eventsPerSecond: 20,
      eventBurst: 40,
      strikeThreshold: 40,
      strikeWindowSeconds: 10,
      blockSeconds: 30,
      trustedProxyHops: 0,
    });
  });

  it("reads the environment", () => {
    assert.deepEqual(
      loadAbuseConfig({
        RATE_LIMIT_EVENTS_PER_SECOND: "12.5",
        RATE_LIMIT_EVENT_BURST: "25",
        RATE_LIMIT_STRIKE_THRESHOLD: "30",
        RATE_LIMIT_STRIKE_WINDOW_SECONDS: "5",
        RATE_LIMIT_BLOCK_SECONDS: "60",
        TRUSTED_PROXY_HOPS: "2",
      }),
      { eventsPerSecond: 12.5, eventBurst: 25, strikeThreshold: 30, strikeWindowSeconds: 5, blockSeconds: 60, trustedProxyHops: 2 },
    );
  });

  it("refuses values out of range", () => {
    assert.throws(() => loadAbuseConfig({ RATE_LIMIT_EVENTS_PER_SECOND: "0" }), /RATE_LIMIT_EVENTS_PER_SECOND/);
    assert.throws(() => loadAbuseConfig({ RATE_LIMIT_EVENTS_PER_SECOND: "abc" }), /RATE_LIMIT_EVENTS_PER_SECOND/);
    assert.throws(() => loadAbuseConfig({ RATE_LIMIT_EVENT_BURST: "-1" }), /RATE_LIMIT_EVENT_BURST/);
    assert.throws(() => loadAbuseConfig({ RATE_LIMIT_EVENT_BURST: "2.5" }), /RATE_LIMIT_EVENT_BURST/);
    assert.throws(() => loadAbuseConfig({ RATE_LIMIT_STRIKE_THRESHOLD: "0" }), /RATE_LIMIT_STRIKE_THRESHOLD/);
    assert.throws(() => loadAbuseConfig({ RATE_LIMIT_BLOCK_SECONDS: "0" }), /RATE_LIMIT_BLOCK_SECONDS/);
    assert.throws(() => loadAbuseConfig({ TRUSTED_PROXY_HOPS: "-1" }), /TRUSTED_PROXY_HOPS/);
    assert.throws(() => loadAbuseConfig({ TRUSTED_PROXY_HOPS: "1.5" }), /TRUSTED_PROXY_HOPS/);
  });

  it("accepts 0 trusted proxies", () => {
    assert.equal(loadAbuseConfig({ TRUSTED_PROXY_HOPS: "0" }).trustedProxyHops, 0);
  });
});
