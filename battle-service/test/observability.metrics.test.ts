import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { Redis } from "ioredis";
import type { Socket as ClientSocket } from "socket.io-client";
import type { RecordMatchResult } from "../src/application/usecases/RecordMatchResult.js";
import { loadEnv } from "../src/config/env.js";
import { countingAbuseAudit, countingAuthAudit } from "../src/infrastructure/metrics/countingAudits.js";
import { startMetricsServer } from "../src/infrastructure/metrics/metricsServer.js";
import { PromMetrics } from "../src/infrastructure/metrics/PromMetrics.js";
import { InMemorySessionTracker } from "../src/infrastructure/persistence/InMemorySessionTracker.js";
import { RedisSessionTracker } from "../src/infrastructure/redis/RedisSessionTracker.js";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { stubTokenVerifier } from "./support/auth.js";
import { pickSong, readyUp } from "./support/ready.js";
import { ok, SocketHarness, waitUntil } from "./support/socketHarness.js";

/** Every battle-service metric of the OBS-1 tables. */
const METRIC_NAMES = [
  "dancesync_socket_connections",
  "dancesync_rooms_active",
  "dancesync_battles_started_total",
  "dancesync_sessions_started_total",
  "dancesync_votes_total",
  "dancesync_word_rounds_total",
  "dancesync_socket_events_total",
  "dancesync_battle_duration_seconds",
  "dancesync_http_request_duration_seconds",
  "dancesync_socket_event_duration_seconds",
  "dancesync_errors_total",
  "dancesync_auth_rejected_total",
  "dancesync_abuse_events_total",
  "dancesync_match_outbox_pending",
  "dancesync_room_conflicts_total",
];

/** The value of one sample (`name{labels}`) in the Prometheus text format, or undefined. */
function sample(text: string, series: string): number | undefined {
  const line = text.split("\n").find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

/** Counts disconnects so a test can wait for the server to see one. */
class DisconnectSpy extends PromMetrics {
  disconnects = 0;

  override socketDisconnected(kind: "user" | "guest"): void {
    this.disconnects += 1;
    super.socketDisconnected(kind);
  }
}

async function scrape(metrics: PromMetrics): Promise<string> {
  return metrics.registry.metrics();
}

describe("OBS-1: the metrics endpoint", () => {
  it("serves /metrics on its own port with every dancesync_ metric and the Node defaults", async () => {
    const metrics = new PromMetrics();
    metrics.httpRequestHandled("GET", "/api/rooms/:code", 200, 0.012);
    metrics.socketEventHandled("room:join", 0.004);
    metrics.battleFinished(75);
    const server: Server = await startMetricsServer(metrics.registry, 0);
    try {
      const base = `http://localhost:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${base}/metrics`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
      const text = await response.text();
      for (const name of METRIC_NAMES) assert.match(text, new RegExp(`^# TYPE ${name} `, "m"), name);
      assert.match(text, /^process_cpu_seconds_total /m);
      assert.match(text, /^nodejs_eventloop_lag_seconds /m);
      assert.equal(sample(text, 'dancesync_socket_connections{kind="guest"}'), 0, "known series start at 0");
      assert.equal(
        sample(text, 'dancesync_http_request_duration_seconds_count{method="GET",route="/api/rooms/:code",status="200"}'),
        1,
      );

      assert.equal((await fetch(`${base}/`)).status, 404);
      assert.equal((await fetch(`${base}/metrics`, { method: "POST" })).status, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("defaults METRICS_PORT to 9464 and validates it", () => {
    assert.equal(loadEnv({}).metricsPort, 9464);
    assert.equal(loadEnv({ METRICS_PORT: "9500" }).metricsPort, 9500);
    assert.throws(() => loadEnv({ METRICS_PORT: "abc" }), /METRICS_PORT/);
  });
});

describe("OBS-1: business metrics counted by the socket handlers", () => {
  it("counts connections, handled events, the battle start and the votes", async () => {
    const metrics = new DisconnectSpy({ defaultMetrics: false });
    const harness = new SocketHarness();
    await harness.start({
      auth: { verifier: stubTokenVerifier },
      extend: () => ({ metrics, sessions: new InMemorySessionTracker() }),
    });
    try {
      const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
      const sockets: Record<string, ClientSocket> = {};
      for (const [id, role] of [
        ["host", "dancer"],
        ["d2", "dancer"],
        ["fan", "spectator"],
      ] as const) {
        sockets[id] = await harness.client(`user:${id}`);
        await ok(sockets[id], "room:join", { roomCode: code, displayName: id });
        await ok(sockets[id], "role:select", { roomCode: code, playerId: id, role });
      }
      await readyUp(code, sockets);
      await pickSong(harness.rooms, code);
      await ok<RoomDto>(sockets.host, "battle:start", { roomCode: code, requesterId: "host" });
      await ok(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "host" });
      await ok(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "host" });

      const text = await scrape(metrics);
      assert.equal(sample(text, 'dancesync_socket_connections{kind="user"}'), 3);
      assert.equal(sample(text, 'dancesync_sessions_started_total{kind="user"}'), 3);
      assert.equal(sample(text, "dancesync_battles_started_total"), 1);
      assert.equal(sample(text, "dancesync_votes_total"), 1, "repeating the same vote is not a new vote");
      assert.equal(sample(text, 'dancesync_socket_events_total{event="room:join"}'), 3);
      assert.equal(sample(text, 'dancesync_socket_events_total{event="vote:cast"}'), 2);
      assert.equal(sample(text, 'dancesync_socket_event_duration_seconds_count{event="battle:start"}'), 1);

      sockets.d2.disconnect();
      await waitUntil(() => metrics.disconnects === 1, "the server sees the disconnect");
      assert.equal(sample(await scrape(metrics), 'dancesync_socket_connections{kind="user"}'), 2);
    } finally {
      await harness.stop();
    }
  });

  it("reports the active rooms and the pending matches on each sweep", async () => {
    const metrics = new PromMetrics({ defaultMetrics: false });
    const harness = new SocketHarness();
    const recordMatchResult = {
      enqueueFinished: async () => false,
      drain: async () => ({ delivered: 0, failed: 0 }),
      pendingCount: async () => 4,
    } as unknown as RecordMatchResult;
    await harness.start({ extend: () => ({ metrics, recordMatchResult }) });
    try {
      await harness.createRoom.execute({ hostId: "a", displayName: "A" });
      await harness.createRoom.execute({ hostId: "b", displayName: "B" });
      await harness.handlers().sweep();
      const text = await scrape(metrics);
      assert.equal(sample(text, "dancesync_rooms_active"), 2);
      assert.equal(sample(text, "dancesync_match_outbox_pending"), 4);
    } finally {
      await harness.stop();
    }
  });
});

describe("OBS-1: rejections and abuse are counted next to their audit lines", () => {
  it("counts by channel and action and still writes every audit entry", async () => {
    const metrics = new PromMetrics({ defaultMetrics: false });
    const written: string[] = [];
    const auth = countingAuthAudit({ rejected: (entry) => written.push(entry.channel) }, metrics);
    auth.rejected({ channel: "http", code: "UNAUTHORIZED", reason: "missing_token", correlationId: "c1" });
    auth.rejected({ channel: "socket.io", code: "UNAUTHORIZED", reason: "missing_token", correlationId: "c2" });
    auth.rejected({ channel: "socket.io", code: "FORBIDDEN", reason: "guest_out_of_scope", correlationId: "c3" });
    const abuse = countingAbuseAudit(
      { limited: () => written.push("limited"), blocked: () => written.push("blocked"), refused: () => written.push("refused") },
      metrics,
    );
    abuse.limited({ channel: "socket.io", ip: "203.0.113.1" });
    abuse.blocked({ channel: "socket.io", ip: "203.0.113.1" });

    assert.deepEqual(written, ["http", "socket.io", "socket.io", "limited", "blocked"]);
    const text = await scrape(metrics);
    assert.equal(sample(text, 'dancesync_auth_rejected_total{channel="http"}'), 1);
    assert.equal(sample(text, 'dancesync_auth_rejected_total{channel="socket.io"}'), 2);
    assert.equal(sample(text, 'dancesync_abuse_events_total{action="limited"}'), 1);
    assert.equal(sample(text, 'dancesync_abuse_events_total{action="blocked"}'), 1);
    assert.equal(sample(text, 'dancesync_abuse_events_total{action="refused"}'), 0);
  });
});

describe("OBS-1: signed-in sessions (one per user per 30 min without a handshake)", () => {
  it("in memory: the first handshake starts a session, reconnects inside the window do not", async () => {
    let now = 0;
    const sessions = new InMemorySessionTracker(30 * 60_000, () => now);
    assert.equal(await sessions.touch("ana"), true);
    now += 10 * 60_000;
    assert.equal(await sessions.touch("ana"), false);
    now += 25 * 60_000; // 25 min after the last handshake: still the same session.
    assert.equal(await sessions.touch("ana"), false);
    now += 30 * 60_000;
    assert.equal(await sessions.touch("ana"), true);
    assert.equal(await sessions.touch("bea"), true);
  });

  it(
    "in Redis: two replicas count a user once",
    { skip: !process.env.TEST_REDIS_URL && "TEST_REDIS_URL is not set" },
    async () => {
      const redis = new Redis(process.env.TEST_REDIS_URL!);
      const prefix = `test:session:${randomUUID().slice(0, 8)}:`;
      try {
        const replicaA = new RedisSessionTracker(redis, { prefix });
        const replicaB = new RedisSessionTracker(redis, { prefix });
        const results = await Promise.all([replicaA.touch("ana"), replicaB.touch("ana")]);
        assert.deepEqual(results.sort(), [false, true]);
        assert.equal(await replicaB.touch("ana"), false);
        const ttl = await redis.pttl(`${prefix}ana`);
        assert.ok(ttl > 29 * 60_000 && ttl <= 30 * 60_000, `window renewed (${ttl} ms)`);
      } finally {
        const keys = await redis.keys(`${prefix}*`);
        if (keys.length > 0) await redis.del(...keys);
        await redis.quit();
      }
    },
  );
});
