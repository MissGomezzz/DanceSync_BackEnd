import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import express from "express";
import type { RecordMatchResult } from "../src/application/usecases/RecordMatchResult.js";
import { CreateRoom } from "../src/application/usecases/CreateRoom.js";
import { loadEnv } from "../src/config/env.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { buildRouter, type HttpDependencies } from "../src/infrastructure/http/routes.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";
import { loadRedisConfig } from "../src/infrastructure/redis/redisConfig.js";
import { createStateStores } from "../src/infrastructure/redis/stateStores.js";
import { battleRoom } from "./support/battles.js";
import { silentAudit, stubTokenVerifier } from "./support/auth.js";
import { SocketHarness } from "./support/socketHarness.js";

/**
 * DIS-1 failure detection: the readiness probe the load balancer (Azure
 * Container Apps) uses to take a replica out of rotation, the heartbeat
 * settings, and a sweep that keeps going when one room fails.
 */
const servers: Server[] = [];

after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function serve(extra: Partial<HttpDependencies>): Promise<string> {
  const rooms = new InMemoryRoomRepository();
  const app = express();
  app.use(buildRouter({ auth: { verifier: stubTokenVerifier, audit: silentAudit }, createRoom: new CreateRoom(rooms), rooms, ...extra }));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

describe("Readiness probe GET /api/battles/health/ready (DIS-1)", () => {
  it("is ready when the shared state store answers, without a token", async () => {
    const base = await serve({ readiness: async () => undefined });
    const response = await fetch(`${base}/api/battles/health/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "UP", service: "battle-service", checks: { stateStore: "UP" } });
  });

  it("answers 503 when the store fails, and also when it does not answer in time", async () => {
    const original = console.warn;
    console.warn = () => undefined;
    try {
      const failing = await serve({ readiness: async () => Promise.reject(new Error("ECONNREFUSED")) });
      const failed = await fetch(`${failing}/api/battles/health/ready`);
      assert.equal(failed.status, 503);
      assert.equal(((await failed.json()) as { status: string }).status, "DOWN");

      const hanging = await serve({ readiness: () => new Promise<void>(() => undefined), readinessTimeoutMs: 50 });
      const started = Date.now();
      assert.equal((await fetch(`${hanging}/api/battles/health/ready`)).status, 503);
      assert.ok(Date.now() - started < 1_000, "answers before the probe gives up");
    } finally {
      console.warn = original;
    }
  });

  it("keeps the liveness check independent of the store", async () => {
    const base = await serve({ readiness: async () => Promise.reject(new Error("down")) });
    assert.equal((await fetch(`${base}/api/battles/health`)).status, 200);
  });

  it("pings the real stores: in memory always, Redis when TEST_REDIS_URL is set", async () => {
    const memory = createStateStores(loadRedisConfig({}));
    await memory.ping();
    if (!process.env.TEST_REDIS_URL) return;
    const redis = createStateStores(loadRedisConfig({ REDIS_URL: process.env.TEST_REDIS_URL }));
    try {
      await redis.ping();
    } finally {
      await redis.close();
    }
  });
});

describe("Failure detection settings (DIS-1)", () => {
  it("defaults to a 10 s + 5 s heartbeat, a 15 s sweep and a 1.5 s adapter request timeout", () => {
    const env = loadEnv({});
    assert.equal(env.socketPingIntervalMs, 10_000);
    assert.equal(env.socketPingTimeoutMs, 5_000);
    assert.equal(env.roomSweepIntervalMs, 15_000);
    assert.equal(loadRedisConfig({}).adapterRequestsTimeoutMs, 1_500);
  });

  it("reads overrides and refuses invalid values", () => {
    const env = loadEnv({ SOCKET_PING_INTERVAL_MS: "4000", SOCKET_PING_TIMEOUT_MS: "2000", ROOM_SWEEP_INTERVAL_MS: "5000" });
    assert.deepEqual([env.socketPingIntervalMs, env.socketPingTimeoutMs, env.roomSweepIntervalMs], [4_000, 2_000, 5_000]);
    for (const source of [{ SOCKET_PING_INTERVAL_MS: "0" }, { SOCKET_PING_TIMEOUT_MS: "-1" }, { ROOM_SWEEP_INTERVAL_MS: "1.5" }]) {
      assert.throws(() => loadEnv(source), /Environment variable/, JSON.stringify(source));
    }
    assert.throws(() => loadRedisConfig({ REDIS_ADAPTER_REQUESTS_TIMEOUT_MS: "0" }), /REDIS_ADAPTER_REQUESTS_TIMEOUT_MS/);
  });
});

describe("Sweep resilience (DIS-1)", () => {
  it("one room that fails does not stop the sweep of the others", async () => {
    const harness = new SocketHarness();
    const finished = RoomService.finishBattle(battleRoom(["a", "b"], []), "song-end");
    const failing = { enqueueFinished: async () => Promise.reject(new Error("store down")), drain: async () => ({ delivered: 0, failed: 0 }) };
    await harness.start({ extend: () => ({ recordMatchResult: failing as unknown as RecordMatchResult }) });
    const original = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      await harness.rooms.insert(finished);
      // An empty room the sweep must delete, whatever happens to the finished one.
      const empty = { ...RoomService.create({ id: "gone", displayName: "Gone" }, "EMPTY1"), players: [] };
      await harness.rooms.insert(empty);
      await harness.handlers().sweep();
      assert.equal(await harness.rooms.findByCode("EMPTY1"), undefined, "the empty room was still reaped");
      assert.ok(logged.some((entry) => String((entry as unknown[])[0]).includes(`Error sweeping room ${finished.code}`)));
    } finally {
      console.error = original;
      await harness.stop();
    }
  });
});
