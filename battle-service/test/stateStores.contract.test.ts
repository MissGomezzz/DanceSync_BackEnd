import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Redis } from "ioredis";
import { DomainError } from "../src/domain/errors/DomainError.js";
import type { Room } from "../src/domain/model/Room.js";
import type { WordRace } from "../src/domain/model/WordRace.js";
import type { RoomRepository } from "../src/domain/ports/RoomRepository.js";
import type { WordRaceRepository } from "../src/domain/ports/WordRaceRepository.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";
import { InMemoryWordRaceRepository } from "../src/infrastructure/persistence/InMemoryWordRaceRepository.js";
import { RedisRoomRepository } from "../src/infrastructure/redis/RedisRoomRepository.js";
import { RedisWordRaceRepository } from "../src/infrastructure/redis/RedisWordRaceRepository.js";

/**
 * The same behavior is demanded of every implementation of the two ports: the
 * in-memory one (always) and the Redis one (when TEST_REDIS_URL points to a
 * disposable Redis, e.g. `docker run -p 6379:6379 redis:7`). Redis keys are
 * unique per test and removed afterwards; nothing else in that Redis is touched.
 */
interface Stores {
  name: string;
  rooms: RoomRepository;
  races: WordRaceRepository;
  /** Lost optimistic-lock races so far (Redis only). */
  conflicts(): number;
}

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const createdCodes: string[] = [];
let redis: Redis | undefined;

function newCode(): string {
  const code = `T${randomUUID().slice(0, 7).toUpperCase()}`;
  createdCodes.push(code);
  return code;
}

function newRoom(code = newCode()): Room {
  return RoomService.create({ id: "host", displayName: "Host" }, code);
}

function newRace(roomCode: string, base = new Date("2030-01-01T00:00:00.000Z")): WordRace {
  const at = (ms: number) => new Date(base.getTime() + ms);
  return {
    roomCode,
    battleId: "battle-1",
    participantIds: ["host", "guest"],
    participantNames: { host: "Host", guest: "Guest" },
    rounds: [1, 2, 3].map((number) => ({
      id: `round-${number}`,
      number,
      word: `palabra${number}`,
      opensAt: at(number * 10_000),
      closesAt: at(number * 10_000 + 5_000),
      winnerId: null,
      status: "scheduled" as const,
    })),
    wins: { host: 0, guest: 0 },
  };
}

const implementations: Array<() => Stores> = [
  () => {
    const rooms = new InMemoryRoomRepository();
    return { name: "in memory", rooms, races: new InMemoryWordRaceRepository(), conflicts: () => 0 };
  },
];
if (TEST_REDIS_URL) {
  implementations.push(() => {
    redis ??= new Redis(TEST_REDIS_URL);
    const rooms = new RedisRoomRepository(redis, { ttlSeconds: 300, maxAttempts: 25 });
    return { name: "Redis", rooms, races: new RedisWordRaceRepository(redis, { ttlSeconds: 300 }), conflicts: () => rooms.stats.conflictRetries };
  });
}

after(async () => {
  if (!redis) return;
  const keys = createdCodes.flatMap((code) => [`room:{${code}}`, `wordrace:{${code}}`]);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
});

for (const make of implementations) {
  const stores = make();
  const { rooms, races } = stores;

  describe(`RoomRepository (${stores.name})`, () => {
    it("inserts once and finds the room whatever the case of the code", async () => {
      const room = newRoom();
      assert.equal(await rooms.insert(room), true);
      assert.equal(await rooms.insert(room), false, "a second insert of the same code is refused");
      assert.deepEqual(await rooms.findByCode(room.code.toLowerCase()), room);
      assert.equal(await rooms.findByCode(newCode()), undefined);
    });

    it("lists the codes of the stored rooms", async () => {
      const a = newRoom();
      const b = newRoom();
      await rooms.insert(a);
      await rooms.insert(b);
      const codes = await rooms.listCodes();
      assert.ok(codes.includes(a.code) && codes.includes(b.code));
    });

    it("stores a change with the next version and returns what it stored", async () => {
      const room = newRoom();
      await rooms.insert(room);
      const stored = await rooms.update(room.code, (current) => RoomService.join(current, { id: "ana", displayName: "Ana" }));
      assert.ok(stored);
      assert.equal(stored.version, room.version + 1);
      assert.deepEqual(await rooms.findByCode(room.code), stored);
    });

    it("keeps Date values as Dates", async () => {
      const room = newRoom();
      await rooms.insert(room);
      const stored = (await rooms.findByCode(room.code))!;
      assert.ok(stored.createdAt instanceof Date);
      assert.equal(stored.createdAt.getTime(), room.createdAt.getTime());
    });

    it("does not write when the mutation changes nothing", async () => {
      const room = newRoom();
      await rooms.insert(room);
      const result = await rooms.update(room.code, (current) => current);
      assert.equal(result?.version, room.version);
      assert.equal((await rooms.findByCode(room.code))?.version, room.version);
    });

    it("removes the room when the mutation returns null", async () => {
      const room = newRoom();
      await rooms.insert(room);
      assert.equal(await rooms.update(room.code, () => null), null);
      assert.equal(await rooms.findByCode(room.code), undefined);
    });

    it("rejects an update of a room that does not exist", async () => {
      await assert.rejects(
        () => rooms.update(newCode(), (current) => current),
        (error) => error instanceof DomainError && error.code === "ROOM_NOT_FOUND",
      );
    });

    it("leaves the room untouched when the decision fails", async () => {
      const room = newRoom();
      await rooms.insert(room);
      await assert.rejects(() =>
        rooms.update(room.code, () => {
          throw new DomainError("NOT_HOST", "only the host");
        }),
      );
      assert.deepEqual(await rooms.findByCode(room.code), room);
    });

    it("refuses a mutation that returns a stale copy of the room", async () => {
      const room = newRoom();
      await rooms.insert(room);
      const old = (await rooms.findByCode(room.code))!;
      await rooms.update(room.code, (current) => RoomService.join(current, { id: "ana", displayName: "Ana" }));
      await assert.rejects(() => rooms.update(room.code, () => old), /Stale write/);
    });

    it("loses no change when several writers update the same room at once", async () => {
      const before = stores.conflicts();
      for (let round = 0; round < 10; round += 1) {
        const room = newRoom();
        await rooms.insert(room);
        // A full room: the host plus six joining at the same instant.
        const joins = Array.from({ length: 6 }, (_, i) =>
          rooms.update(room.code, (current) => RoomService.join(current, { id: `p${i}`, displayName: `P${i}` })),
        );
        await Promise.all(joins);
        const stored = (await rooms.findByCode(room.code))!;
        assert.equal(stored.players.length, 7, "every join was kept");
        assert.equal(stored.version, 6, "one version per stored change");
        assert.equal(new Set(stored.players.map((p) => p.id)).size, 7);
      }
      if (stores.name === "Redis") assert.ok(stores.conflicts() > before, "the test should have provoked real optimistic-lock conflicts");
    });

    it("decides each concurrent change on the latest state (a full room refuses the extra player)", async () => {
      const room = newRoom();
      await rooms.insert(room);
      const attempts = await Promise.allSettled(
        Array.from({ length: 9 }, (_, i) => rooms.update(room.code, (current) => RoomService.join(current, { id: `p${i}`, displayName: `P${i}` }))),
      );
      assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 6, "7 seats, 1 taken by the host");
      assert.equal(attempts.filter((a) => a.status === "rejected").length, 3);
      assert.equal((await rooms.findByCode(room.code))?.players.length, 7);
    });
  });

  describe(`WordRaceRepository (${stores.name})`, () => {
    it("saves a race and reads it back identically", async () => {
      const code = newCode();
      const race = newRace(code);
      await races.save(race);
      assert.deepEqual(await races.find(code.toLowerCase()), race);
      assert.equal(await races.find(newCode()), undefined);
    });

    it("replaces the previous race of the room on save and forgets it on delete", async () => {
      const code = newCode();
      await races.save(newRace(code));
      await races.save({ ...newRace(code), battleId: "battle-2", rounds: [] });
      assert.equal((await races.find(code))?.battleId, "battle-2");
      assert.equal((await races.find(code))?.rounds.length, 0);
      await races.delete(code);
      assert.equal(await races.find(code), undefined);
    });

    it("opens a scheduled round only once", async () => {
      const code = newCode();
      await races.save(newRace(code));
      const opened = await races.openRound(code, "round-1");
      assert.equal(opened?.status, "open");
      assert.equal(await races.openRound(code, "round-1"), null, "an open round cannot be opened again");
      assert.equal(await races.openRound(code, "nope"), null);
      assert.equal(await races.openRound(newCode(), "round-1"), null);
    });

    it("lets exactly one of 100 simultaneous submissions win a round", async () => {
      const code = newCode();
      const race = newRace(code);
      await races.save(race);
      await races.openRound(code, "round-1");
      const now = new Date(race.rounds[0].opensAt.getTime() + 100);
      const claims = await Promise.all(
        Array.from({ length: 100 }, (_, i) => races.claimRound(code, "round-1", i % 2 === 0 ? "host" : "guest", now)),
      );
      const winners = claims.filter((c) => c.claimed);
      assert.equal(winners.length, 1, "a single claim wins");
      const winnerId = winners[0].round.winnerId!;
      assert.ok(claims.filter((c) => !c.claimed).every((c) => c.round?.status === "won" && c.round.winnerId === winnerId));
      const stored = (await races.find(code))!;
      assert.equal(stored.wins[winnerId], 1, "the win is counted once");
      assert.equal(Object.values(stored.wins).reduce((a, b) => a + b, 0), 1);
    });

    it("refuses a claim on a round that is not open or whose window closed", async () => {
      const code = newCode();
      const race = newRace(code);
      await races.save(race);
      const inside = new Date(race.rounds[0].opensAt.getTime() + 100);
      assert.equal((await races.claimRound(code, "round-1", "host", inside)).claimed, false, "scheduled, not open yet");
      await races.openRound(code, "round-1");
      const late = new Date(race.rounds[0].closesAt.getTime());
      assert.equal((await races.claimRound(code, "round-1", "host", late)).claimed, false, "at closesAt the window is over");
      const missing = await races.claimRound(code, "nope", "host", inside);
      assert.deepEqual(missing, { claimed: false, round: null });
      assert.deepEqual(await races.claimRound(newCode(), "round-1", "host", inside), { claimed: false, round: null });
    });

    it("expires an open round only once its window is over, and then nobody can claim it", async () => {
      const code = newCode();
      const race = newRace(code);
      await races.save(race);
      await races.openRound(code, "round-1");
      const { opensAt, closesAt } = race.rounds[0];
      assert.equal(await races.expireRound(code, "round-1", new Date(opensAt.getTime() + 10)), null, "too early");
      const expired = await races.expireRound(code, "round-1", closesAt);
      assert.equal(expired?.status, "expired");
      assert.equal(await races.expireRound(code, "round-1", closesAt), null, "already expired");
      assert.equal((await races.claimRound(code, "round-1", "host", new Date(opensAt.getTime() + 10))).claimed, false);
    });

    it("never expires a round that was won, and never lets an expired round be won", async () => {
      const code = newCode();
      const race = newRace(code);
      await races.save(race);
      await races.openRound(code, "round-1");
      await races.openRound(code, "round-2");
      const early = new Date(race.rounds[0].opensAt.getTime() + 10);
      assert.equal((await races.claimRound(code, "round-1", "guest", early)).claimed, true);
      assert.equal(await races.expireRound(code, "round-1", race.rounds[0].closesAt), null);
      assert.equal((await races.find(code))?.rounds[0].winnerId, "guest");
      // Round 2: the timer and a late submission meet at the deadline; only one of them takes effect.
      const deadline = race.rounds[1].closesAt;
      const [expired, claim] = await Promise.all([
        races.expireRound(code, "round-2", deadline),
        races.claimRound(code, "round-2", "host", new Date(deadline.getTime() - 1)),
      ]);
      assert.ok(Boolean(expired) !== claim.claimed, "exactly one of expire and claim takes effect");
    });
  });
}
