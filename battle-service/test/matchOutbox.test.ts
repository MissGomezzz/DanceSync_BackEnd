import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { Redis } from "ioredis";
import { RecordMatchResult } from "../src/application/usecases/RecordMatchResult.js";
import type { MatchRecord } from "../src/domain/model/MatchRecord.js";
import type { Room } from "../src/domain/model/Room.js";
import type { MatchOutbox } from "../src/domain/ports/MatchOutbox.js";
import { MatchPublishError, type MatchResultPublisher } from "../src/domain/ports/MatchResultPublisher.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { InMemoryMatchOutbox } from "../src/infrastructure/persistence/InMemoryMatchOutbox.js";
import { RedisMatchOutbox } from "../src/infrastructure/redis/RedisMatchOutbox.js";
import { at, battleRoom } from "./support/battles.js";

/**
 * DIS-1, 0 finished-match results lost: the durable outbox (both adapters) and
 * how RecordMatchResult uses it so that any replica can deliver a result its
 * finisher could not. The Redis adapter runs when TEST_REDIS_URL is set.
 */
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const namespaces: string[] = [];
let redis: Redis | undefined;

after(async () => {
  if (!redis) return;
  const keys = namespaces.flatMap((n) => [`{${n}}:pending`, `{${n}}:delivered`]);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
});

const T = new Date("2026-03-01T12:00:00.000Z");
const plus = (ms: number) => new Date(T.getTime() + ms);

function match(id = randomUUID()): MatchRecord {
  return {
    id,
    roomCode: "ROOM01",
    songId: "song-1",
    songTitle: "Rasputin",
    startedAt: at(0),
    finishedAt: at(90_000),
    winnerPlayerId: "a",
    endReason: "song-end",
    participants: [{ playerId: "a", displayName: "A", role: "dancer", votes: 1, wordsWon: 2, score: 4, rank: 1, leftEarly: false }],
  };
}

const outboxes: Array<[string, () => MatchOutbox]> = [["in memory", () => new InMemoryMatchOutbox()]];
if (TEST_REDIS_URL) {
  outboxes.push([
    "Redis",
    () => {
      redis ??= new Redis(TEST_REDIS_URL);
      const namespace = `test-outbox-${randomUUID().slice(0, 8)}`;
      namespaces.push(namespace);
      return new RedisMatchOutbox(redis, { deliveredRetentionSeconds: 60, namespace });
    },
  ]);
}

for (const [name, make] of outboxes) {
  describe(`MatchOutbox (${name})`, () => {
    it("enqueues a match once, keeping its dates", async () => {
      const outbox = make();
      const m = match();
      assert.equal(await outbox.enqueue(m, T), true);
      assert.equal(await outbox.enqueue(m, T), false, "already pending");
      const [pending] = await outbox.listPending(T, 10);
      assert.deepEqual(pending, { match: m, attempts: 0, nextAttemptAt: T });
      assert.ok(pending.match.finishedAt instanceof Date);
    });

    it("lists only what is due, the most overdue first, up to the limit", async () => {
      const outbox = make();
      const [late, early, future] = [match(), match(), match()];
      await outbox.enqueue(late, plus(2_000));
      await outbox.enqueue(early, plus(1_000));
      await outbox.enqueue(future, plus(60_000));
      assert.deepEqual((await outbox.listPending(plus(5_000), 10)).map((p) => p.match.id), [early.id, late.id]);
      assert.deepEqual((await outbox.listPending(plus(5_000), 1)).map((p) => p.match.id), [early.id]);
    });

    it("forgets a delivered match and refuses to enqueue it again", async () => {
      const outbox = make();
      const m = match();
      await outbox.enqueue(m, T);
      await outbox.ack(m.id);
      assert.deepEqual(await outbox.listPending(plus(1), 10), []);
      assert.equal(await outbox.enqueue(m, T), false, "delivered recently");
    });

    it("reschedules a failed delivery, unless it was delivered meanwhile", async () => {
      const outbox = make();
      const m = match();
      await outbox.enqueue(m, T);
      await outbox.retryLater({ match: m, attempts: 1, nextAttemptAt: plus(10_000) });
      assert.deepEqual(await outbox.listPending(plus(9_999), 10), []);
      assert.equal((await outbox.listPending(plus(10_000), 10))[0].attempts, 1);
      await outbox.ack(m.id);
      await outbox.retryLater({ match: m, attempts: 2, nextAttemptAt: plus(20_000) });
      assert.deepEqual(await outbox.listPending(plus(60_000), 10), [], "an ack from another replica wins");
    });
  });
}

/** Publisher double: records what reaches users-service, fails `failures` times first. */
class FakePublisher implements MatchResultPublisher {
  readonly stored: MatchRecord[] = [];
  constructor(
    private failures = 0,
    private readonly error: Error = new MatchPublishError("users-service unreachable", true),
  ) {}
  async publish(m: MatchRecord): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw this.error;
    }
    this.stored.push(m);
  }
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

function finishedRoom(): Room {
  return RoomService.finishBattle(battleRoom(["a", "b"], ["s"]), "song-end", at(90_000));
}

function replica(publisher: MatchResultPublisher, outbox: MatchOutbox, now: { value: Date }): RecordMatchResult {
  return new RecordMatchResult(publisher, {
    outbox,
    attempts: 1,
    sleep: async () => undefined,
    clock: () => now.value,
    redeliveryBaseMs: 1_000,
    redeliveryMaxMs: 8_000,
    logger: quiet,
  });
}

describe("RecordMatchResult with the outbox (DIS-1)", () => {
  it("a result whose finisher could not deliver it is delivered by another replica, once", async () => {
    const outbox = new InMemoryMatchOutbox();
    const now = { value: T };
    const finisher = replica(new FakePublisher(Infinity), outbox, now);
    const room = finishedRoom();
    assert.equal(await finisher.execute(room), false, "users-service unreachable from the finisher, which then dies");

    const survivorPublisher = new FakePublisher();
    const survivor = replica(survivorPublisher, outbox, now);
    assert.deepEqual(await survivor.drain(), { delivered: 0, failed: 0 }, "not before the finisher's own tries are over");
    now.value = plus(1_000);
    assert.deepEqual(await survivor.drain(), { delivered: 1, failed: 0 });
    assert.deepEqual(survivorPublisher.stored.map((m) => m.id), [room.battle!.id]);
    assert.deepEqual(await survivor.drain(), { delivered: 0, failed: 0 }, "delivered once");
  });

  it("a result whose finisher died before enqueuing it is enqueued by the sweep, and only once", async () => {
    const outbox = new InMemoryMatchOutbox();
    const now = { value: T };
    const publisher = new FakePublisher();
    const survivor = replica(publisher, outbox, now);
    const room = finishedRoom();
    assert.equal(await survivor.enqueueFinished(room), true);
    assert.equal(await survivor.enqueueFinished(room), false, "already pending");
    assert.equal((await survivor.drain()).delivered, 1);
    assert.equal(await survivor.enqueueFinished(room), false, "already delivered");
    assert.equal(await survivor.enqueueFinished(battleRoom(["a", "b"], [])), false, "nothing to store for a running battle");
    assert.equal(publisher.stored.length, 1);
  });

  it("a delivered result leaves the outbox at once", async () => {
    const outbox = new InMemoryMatchOutbox();
    const publisher = new FakePublisher();
    assert.equal(await replica(publisher, outbox, { value: T }).execute(finishedRoom()), true);
    assert.deepEqual(await outbox.listPending(plus(3_600_000), 10), []);
  });

  it("backs off exponentially, capped, and keeps a refused document at the maximum backoff", async () => {
    const outbox = new InMemoryMatchOutbox();
    const now = { value: T };
    const room = finishedRoom();
    await replica(new FakePublisher(Infinity), outbox, now).execute(room);
    const failing = replica(new FakePublisher(Infinity), outbox, now);
    const nextTry = async () => (await outbox.listPending(plus(86_400_000), 1))[0];
    for (const [i, expectedWait] of [1_000, 2_000, 4_000, 8_000, 8_000].entries()) {
      now.value = (await nextTry()).nextAttemptAt;
      assert.equal((await failing.drain()).failed, 1);
      const pending = await nextTry();
      assert.equal(pending.attempts, i + 1);
      assert.equal(pending.nextAttemptAt.getTime() - now.value.getTime(), expectedWait);
    }
    const refused = replica(new FakePublisher(1, new MatchPublishError("400 bad document", false)), outbox, now);
    now.value = (await nextTry()).nextAttemptAt;
    await refused.drain();
    assert.equal((await nextTry()).nextAttemptAt.getTime() - now.value.getTime(), 8_000, "kept, at the maximum backoff");
  });
});
