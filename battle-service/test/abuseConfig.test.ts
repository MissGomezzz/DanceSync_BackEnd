import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadAbuseConfig } from "../src/infrastructure/abuse/abuseConfig.js";

describe("abuse protection configuration (SEG-3)", () => {
  it("defaults to the scenario values: 20 events per second with bursts of 40", () => {
    assert.deepEqual(loadAbuseConfig({}), { eventsPerSecond: 20, eventBurst: 40 });
  });

  it("reads the environment", () => {
    assert.deepEqual(loadAbuseConfig({ RATE_LIMIT_EVENTS_PER_SECOND: "12.5", RATE_LIMIT_EVENT_BURST: "25" }), {
      eventsPerSecond: 12.5,
      eventBurst: 25,
    });
  });

  it("refuses values that are not positive, and a burst that is not whole", () => {
    assert.throws(() => loadAbuseConfig({ RATE_LIMIT_EVENTS_PER_SECOND: "0" }), /RATE_LIMIT_EVENTS_PER_SECOND/);
    assert.throws(() => loadAbuseConfig({ RATE_LIMIT_EVENTS_PER_SECOND: "abc" }), /RATE_LIMIT_EVENTS_PER_SECOND/);
    assert.throws(() => loadAbuseConfig({ RATE_LIMIT_EVENT_BURST: "-1" }), /RATE_LIMIT_EVENT_BURST/);
    assert.throws(() => loadAbuseConfig({ RATE_LIMIT_EVENT_BURST: "2.5" }), /RATE_LIMIT_EVENT_BURST/);
  });
});
