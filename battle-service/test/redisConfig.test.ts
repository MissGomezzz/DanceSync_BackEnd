import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeRedisUrl, loadRedisConfig } from "../src/infrastructure/redis/redisConfig.js";

describe("Redis configuration", () => {
  it("keeps the state in memory when REDIS_URL is not set", () => {
    const config = loadRedisConfig({});
    assert.equal(config.url, "");
    assert.equal(config.ttlSeconds, 86_400);
    assert.equal(config.maxUpdateAttempts, 12);
    assert.equal(config.adapterKey, "dancesync");
  });

  it("reads the URL and the tuning values", () => {
    const config = loadRedisConfig({
      REDIS_URL: " rediss://cache.example.com:6380 ",
      REDIS_STATE_TTL_SECONDS: "600",
      REDIS_UPDATE_MAX_ATTEMPTS: "5",
      SOCKETIO_REDIS_KEY: "staging",
    });
    assert.deepEqual(config, {
      url: "rediss://cache.example.com:6380",
      ttlSeconds: 600,
      maxUpdateAttempts: 5,
      adapterKey: "staging",
    });
  });

  it("refuses a URL that is not a Redis one and numbers that are not positive integers", () => {
    assert.throws(() => loadRedisConfig({ REDIS_URL: "http://localhost:6379" }), /REDIS_URL/);
    assert.throws(() => loadRedisConfig({ REDIS_STATE_TTL_SECONDS: "0" }), /REDIS_STATE_TTL_SECONDS/);
    assert.throws(() => loadRedisConfig({ REDIS_UPDATE_MAX_ATTEMPTS: "abc" }), /REDIS_UPDATE_MAX_ATTEMPTS/);
  });

  it("never prints credentials", () => {
    assert.equal(describeRedisUrl("rediss://default:s3cret@cache.example.com:6380/0"), "rediss://cache.example.com:6380");
  });
});
