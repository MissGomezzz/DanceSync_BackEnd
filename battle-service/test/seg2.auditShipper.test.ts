import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuditEntry } from "../src/application/ports/AuditTrail.js";
import { loadAuditConfig, type AuditConfig } from "../src/infrastructure/audit/auditConfig.js";
import { HttpAuditShipper, type AuditWireRecord } from "../src/infrastructure/audit/HttpAuditShipper.js";
import { auditDetail } from "../src/infrastructure/audit/socketAudit.js";

const TOKEN = "test-internal-token-of-at-least-32-bytes";

function config(overrides: Partial<AuditConfig> = {}): AuditConfig {
  return {
    enabled: true,
    ingestUrl: "http://users-service/internal/audit/events",
    internalToken: TOKEN,
    // The tests flush by hand.
    flushIntervalMs: 3_600_000,
    batchSize: 2,
    bufferCapacity: 100,
    ...overrides,
  };
}

const entry = (action: string): AuditEntry => ({
  action,
  outcome: "ok",
  userId: "user-ana",
  userKind: "user",
  ip: "203.0.113.7",
  userAgent: "Chrome",
  correlationId: "c-1",
});

/** A users-service that answers with the statuses given, one per request, and keeps what it received. */
function usersService(...statuses: number[]) {
  const received: { headers: Record<string, string>; events: AuditWireRecord[] }[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
    if (status === 0) throw new TypeError("fetch failed");
    received.push({
      headers: init?.headers as Record<string, string>,
      events: (JSON.parse(String(init?.body)) as { events: AuditWireRecord[] }).events,
    });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { received, fetchImpl };
}

describe("SEG-2 audit shipper: delivery to users-service", () => {
  it("stamps each record (event id, UTC time, service) and sends batches with the internal secret", async () => {
    const service = usersService(202);
    const shipper = new HttpAuditShipper(config(), {
      fetchImpl: service.fetchImpl,
      now: () => new Date("2026-11-15T12:00:00.123Z"),
    });
    for (const action of ["room:join", "vote:cast", "chat:message"]) shipper.record(entry(action));

    await shipper.flush();

    assert.equal(service.received.length, 2);
    assert.equal(service.received[0].headers["x-internal-token"], TOKEN);
    const [first] = service.received[0].events;
    assert.match(first.eventId, /^[0-9a-f-]{36}$/);
    assert.equal(first.occurredAt, "2026-11-15T12:00:00.123Z");
    assert.match(first.source, /^battle-service@/);
    assert.equal(first.channel, "socket.io");
    assert.equal(first.action, "room:join");
    assert.deepEqual(shipper.getStats(), { shipped: 3, dropped: 0, refused: 0, backlog: 0 });
  });

  it("keeps the batch while users-service is down and delivers it once it is back", async () => {
    const service = usersService(503, 0, 202);
    const shipper = new HttpAuditShipper(config(), { fetchImpl: service.fetchImpl });
    shipper.record(entry("vote:cast"));

    await shipper.flush();
    assert.equal(shipper.getStats().backlog, 1);
    // Back-off: an immediate retry does not hammer users-service.
    await shipper.flush();
    assert.equal(service.received.length, 1);

    await sleep(1_050);
    await shipper.flush();
    assert.equal(shipper.getStats().backlog, 1, "the network error keeps it too");
    await sleep(2_050);
    await shipper.flush();
    assert.equal(shipper.getStats().backlog, 0);
    assert.equal(service.received.at(-1)!.events[0].eventId, service.received[0].events[0].eventId, "the same event id is resent");
  });

  it("a batch refused as invalid is dropped, not retried forever", async () => {
    const service = usersService(400);
    const shipper = new HttpAuditShipper(config(), { fetchImpl: service.fetchImpl });
    shipper.record(entry("vote:cast"));

    await shipper.flush();

    assert.deepEqual(shipper.getStats(), { shipped: 0, dropped: 0, refused: 1, backlog: 0 });
  });

  it("a full buffer drops new records instead of growing without bound", () => {
    const results: string[] = [];
    const shipper = new HttpAuditShipper(config({ bufferCapacity: 2 }), { onResult: (result) => results.push(result) });
    for (let i = 0; i < 4; i++) shipper.record(entry("chat:message"));

    assert.equal(shipper.getStats().backlog, 2);
    assert.equal(shipper.getStats().dropped, 2);
    assert.deepEqual(results, ["dropped", "dropped"]);
  });

  it("without the internal secret nothing is sent; with AUDIT_ENABLED=false nothing is kept", async () => {
    const service = usersService(202);
    const waiting = new HttpAuditShipper(config({ internalToken: "" }), { fetchImpl: service.fetchImpl });
    waiting.record(entry("vote:cast"));
    await waiting.flush();
    assert.equal(service.received.length, 0);
    assert.equal(waiting.getStats().backlog, 1);

    const disabled = new HttpAuditShipper(config({ enabled: false }), { fetchImpl: service.fetchImpl });
    disabled.record(entry("vote:cast"));
    assert.equal(disabled.getStats().backlog, 0);
  });

  it("close() makes a last delivery attempt", async () => {
    const service = usersService(202);
    const shipper = new HttpAuditShipper(config({ flushIntervalMs: 10 }), { fetchImpl: service.fetchImpl });
    shipper.record(entry("room:leave"));

    await shipper.close();

    assert.equal(shipper.getStats().backlog, 0);
  });
});

describe("SEG-2 audit configuration and detail", () => {
  it("reads the settings and refuses a short secret", () => {
    const loaded = loadAuditConfig({ USERS_SERVICE_URL: "http://users:8081/", AUDIT_INTERNAL_TOKEN: TOKEN });
    assert.equal(loaded.ingestUrl, "http://users:8081/internal/audit/events");
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.flushIntervalMs, 1000);
    assert.equal(loadAuditConfig({ AUDIT_ENABLED: "false" }).enabled, false);
    assert.throws(() => loadAuditConfig({ AUDIT_INTERNAL_TOKEN: "short" }), /at least 32 bytes/);
    assert.throws(() => loadAuditConfig({ AUDIT_BATCH_SIZE: "0" }), /AUDIT_BATCH_SIZE/);
  });

  it("keeps only safe facts of known events", () => {
    assert.equal(auditDetail("vote:cast", { roomCode: "A", dancerId: "user-beto" }), "dancerId=user-beto");
    assert.equal(auditDetail("vote:cast", { roomCode: "A", dancerId: null }), "dancerId=none");
    assert.equal(auditDetail("word:submit", { roundId: "r1", text: "salsa" }), "roundId=r1 word=salsa");
    assert.equal(auditDetail("player:ready", { ready: false }), "ready=false");
    assert.equal(auditDetail("song:choose", { songId: "s-3" }), "songId=s-3");
    assert.equal(auditDetail("battle:start", { dancerIds: ["a", "b", 3] }), "dancerIds=a,b");
    assert.equal(auditDetail("webrtc:signal", { to: "user-beto", description: { sdp: "v=0 IN IP4 10.0.0.1" } }), "to=user-beto");
    assert.equal(auditDetail("chat:message", { content: "secret plans" }), "length=12");
    assert.equal(auditDetail("room:leave", { roomCode: "A" }), undefined);
    assert.equal(auditDetail("vote:cast", "not an object"), undefined);
  });
});
