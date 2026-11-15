import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, describe, it } from "node:test";
import { Redis } from "ioredis";
import { InMemoryBlockList, type BlockList } from "../src/infrastructure/abuse/blockList.js";
import { RedisBlockList } from "../src/infrastructure/redis/RedisBlockList.js";

/** The same behaviour from both implementations; Redis only when TEST_REDIS_URL is set. */
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
let redis: Redis | undefined;
const prefix = `test:block:${randomUUID().slice(0, 8)}:`;

const implementations: Array<[string, () => BlockList]> = [["in memory", () => new InMemoryBlockList()]];
if (TEST_REDIS_URL) {
  implementations.push([
    "Redis",
    () => {
      redis ??= new Redis(TEST_REDIS_URL);
      return new RedisBlockList(redis, prefix);
    },
  ]);
}

after(async () => {
  if (!redis) return;
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
});

for (const [name, make] of implementations) {
  describe(`BlockList (${name})`, () => {
    const blocks = make();

    it("reports nothing for keys that were never blocked", async () => {
      assert.equal(await blocks.remainingMs([`ip:${randomUUID()}`]), 0);
      assert.equal(await blocks.remainingMs([]), 0);
    });

    it("blocks every key it is given, for about the requested time", async () => {
      const ip = `ip:${randomUUID()}`;
      const player = `player:${randomUUID()}`;
      await blocks.block([ip, player], 30_000);
      for (const key of [ip, player]) {
        const remaining = await blocks.remainingMs([key]);
        assert.ok(remaining > 29_000 && remaining <= 30_000, `${key}: ${remaining} ms`);
      }
    });

    it("answers for the longest block among several keys", async () => {
      const short = `ip:${randomUUID()}`;
      const long = `player:${randomUUID()}`;
      await blocks.block([short], 5_000);
      await blocks.block([long], 20_000);
      const remaining = await blocks.remainingMs([short, long, `ip:${randomUUID()}`]);
      assert.ok(remaining > 19_000, `${remaining} ms`);
    });

    it("forgets a block once it expires", async () => {
      const key = `ip:${randomUUID()}`;
      await blocks.block([key], 150);
      assert.ok((await blocks.remainingMs([key])) > 0);
      await sleep(250);
      assert.equal(await blocks.remainingMs([key]), 0);
    });
  });
}
