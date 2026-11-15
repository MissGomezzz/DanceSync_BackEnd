import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { FakeEntra, RecordingAudit } from "./support/auth.js";
import { RecordingAuditTrail } from "./support/audit.js";
import { emit, ok, rejected, SocketHarness, waitUntil } from "./support/socketHarness.js";

/**
 * SEG-2 (non-repudiation) over Socket.IO: every handshake and every client event yields one audit
 * record with the user taken from the validated token (never from an id the client sends), the
 * client's address behind the trusted proxies, the browser, the action, its outcome and the
 * correlation id of the connection. Runs against the real token validation.
 */
const entra = new FakeEntra();
const trail = new RecordingAuditTrail();
const harness = new SocketHarness();
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";

before(async () => {
  await entra.start();
  await harness.start({
    auth: { verifier: entra.verifier(), audit: new RecordingAudit(), guestIssuer: entra.guestIssuer() },
    auditTrail: trail,
    // The test client plays the platform ingress: its X-Forwarded-For entry is trusted.
    trustedProxyHops: 1,
  });
});
after(async () => {
  await harness.stop();
  await entra.stop();
});
beforeEach(() => trail.clear());

async function newRoom(hostId = "user-ana"): Promise<string> {
  return (await harness.createRoom.execute({ hostId, displayName: "Ana" })).code;
}

function headers(ip: string, correlationId: string): Record<string, string> {
  return { "x-forwarded-for": ip, "user-agent": CHROME, "x-correlation-id": correlationId };
}

describe("SEG-2 Socket.IO: every handshake is recorded", () => {
  it("an accepted handshake carries the token's user, the address, the browser and the correlation id", async () => {
    await harness.client(await entra.token({ oid: "user-ana", name: "Ana" }), headers("203.0.113.7", "seg2-hs-ok"));

    await waitUntil(() => trail.of("socket:handshake").length === 1, "the handshake record");
    assert.deepEqual(trail.of("socket:handshake")[0], {
      action: "socket:handshake",
      outcome: "ok",
      userId: "user-ana",
      userKind: "user",
      userName: "Ana",
      ip: "203.0.113.7",
      userAgent: CHROME,
      correlationId: "seg2-hs-ok",
    });
  });

  it("a refused handshake is recorded as anonymous and rejected, with the reason and without the token", async () => {
    const expired = await entra.token({ oid: "user-ana", expiresInSeconds: -60 });
    await harness.refusedClient({ token: expired }, headers("198.51.100.9", "seg2-hs-expired"));
    await harness.refusedClient(undefined, headers("198.51.100.9", "seg2-hs-missing"));

    await waitUntil(() => trail.of("socket:handshake").length === 2, "both refusals");
    const [first, second] = trail.of("socket:handshake");
    assert.equal(first.outcome, "rejected");
    assert.equal(first.code, "expired_token");
    assert.equal(first.userKind, "anonymous");
    assert.equal(first.userId, undefined);
    assert.equal(first.ip, "198.51.100.9");
    assert.equal(first.userAgent, CHROME);
    assert.equal(first.correlationId, "seg2-hs-expired");
    assert.equal(second.code, "missing_token");
    assert.ok(!trail.serialized().includes(expired), "the audit trail contains the token");
  });
});

describe("SEG-2 Socket.IO: every client event is recorded", () => {
  it("records the action, the room, the outcome and the facts that prove what was done", async () => {
    const code = await newRoom();
    const ana = await harness.client(await entra.token({ oid: "user-ana", name: "Ana" }), headers("203.0.113.7", "seg2-ev"));
    await ok(ana, "room:join", { roomCode: code });
    await ok(ana, "chat:message", { roomCode: code, content: "hola a todos" });
    await ok(ana, "role:select", { roomCode: code, role: "dancer" });

    await waitUntil(() => trail.entries.length === 4, "handshake and three events");
    const [join, chat, role] = trail.entries.slice(1);
    assert.deepEqual(join, {
      action: "room:join",
      resource: code,
      outcome: "ok",
      code: undefined,
      detail: undefined,
      userId: "user-ana",
      userKind: "user",
      userName: "Ana",
      ip: "203.0.113.7",
      userAgent: CHROME,
      correlationId: "seg2-ev",
    });
    // The chat text itself is not stored, only that a message of that length was sent.
    assert.equal(chat.detail, "length=12");
    assert.ok(!trail.serialized().includes("hola a todos"));
    assert.equal(role.detail, "role=dancer");
  });

  it("a refused event is recorded as failed with its error code", async () => {
    const ana = await harness.client(await entra.token({ oid: "user-ana" }));
    await rejected(ana, "room:join", { roomCode: "NOPE00" }, "ROOM_NOT_FOUND");
    await rejected(ana, "chat:message", { roomCode: "NOPE00", content: "x" }, "PLAYER_NOT_IN_ROOM");

    await waitUntil(() => trail.entries.length === 3, "the two refusals");
    const [join, chat] = trail.entries.slice(1);
    assert.equal(join.outcome, "failed");
    assert.equal(join.code, "ROOM_NOT_FOUND");
    assert.equal(join.resource, "NOPE00");
    assert.equal(chat.code, "PLAYER_NOT_IN_ROOM");
  });

  it("a guest outside its room is recorded with its own identity and rejected", async () => {
    const own = await newRoom();
    const other = await newRoom("user-beto");
    const response = await fetch(`${harness.baseUrl}/api/rooms/${own}/guest-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Invitada" }),
    });
    const { token, playerId } = (await response.json()) as { token: string; playerId: string };
    const guest = await harness.client(token);

    await rejected(guest, "room:join", { roomCode: other }, "FORBIDDEN");

    await waitUntil(() => trail.of("room:join").length === 1, "the refusal");
    const [join] = trail.of("room:join");
    assert.equal(join.outcome, "rejected");
    assert.equal(join.code, "FORBIDDEN");
    assert.equal(join.userKind, "guest");
    assert.equal(join.userId, playerId);
    assert.equal(join.userName, "Invitada");
  });

  it("the user is always the token's, whatever id the client claims", async () => {
    const code = await newRoom();
    const mallory = await harness.client(await entra.token({ oid: "user-mallory", name: "Mallory" }));
    await ok(mallory, "room:join", { roomCode: code, playerId: "user-ana" });
    await rejected(mallory, "player:kick", { roomCode: code, requesterId: "user-ana", playerId: "user-ana" }, "PLAYER_NOT_IN_ROOM");

    await waitUntil(() => trail.entries.length === 3, "join and kick");
    for (const entry of trail.entries) assert.equal(entry.userId, "user-mallory");
    assert.equal(trail.of("player:kick")[0].detail, "playerId=user-ana");
  });

  it("100 % of the events are recorded, once each", async () => {
    const code = await newRoom();
    const ana = await harness.client(await entra.token({ oid: "user-ana" }));
    await ok(ana, "room:join", { roomCode: code });
    const sent = 25;
    for (let i = 0; i < sent; i++) await emit(ana, "chat:message", { roomCode: code, content: `m${i}` });

    await waitUntil(() => trail.of("chat:message").length === sent, "every chat message");
    assert.equal(trail.of("socket:handshake").length, 1);
    assert.equal(trail.of("room:join").length, 1);
    assert.equal(trail.entries.length, sent + 2);
  });
});

describe("SEG-2 Socket.IO: abuse incidents (SEG-3) are recorded once per incident, not once per event", () => {
  it("a flood yields a few rate_limited records with the dropped count, a blocked record, and a blocked reconnection", async () => {
    const { createServer } = await import("node:http");
    const { Server } = await import("socket.io");
    const { io: connect } = await import("socket.io-client");
    const { attachAbuseProtection } = await import("../src/infrastructure/abuse/abuseProtection.js");
    const { InMemoryBlockList } = await import("../src/infrastructure/abuse/blockList.js");
    const abuseTrail = new RecordingAuditTrail();
    const http = createServer();
    const io = new Server(http, { path: "/socket.io" });
    io.use((socket, next) => {
      socket.data.auth = { kind: "user", playerId: "user-bot", displayName: "Bot" };
      socket.data.correlationId = "corr-bot";
      next();
    });
    attachAbuseProtection(io, {
      config: { eventsPerSecond: 20, eventBurst: 40, strikeThreshold: 40, strikeWindowSeconds: 10, blockSeconds: 30, trustedProxyHops: 1 },
      blocks: new InMemoryBlockList(),
      audit: { limited() {}, blocked() {}, refused() {} },
      trail: abuseTrail,
    });
    io.on("connection", (socket) => socket.on("chat:message", () => {}));
    await new Promise<void>((resolve) => http.listen(0, resolve));
    const url = `http://localhost:${(http.address() as import("node:net").AddressInfo).port}`;
    const options = {
      path: "/socket.io",
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders: { "x-forwarded-for": "198.51.100.66", "user-agent": "flood-bot/1.0" },
    };
    try {
      const bot = connect(url, options);
      await new Promise<void>((resolve) => bot.on("connect", () => resolve()));
      for (let i = 0; i < 200; i++) bot.emit("chat:message", { roomCode: "ABC123", content: "spam" });

      await waitUntil(() => abuseTrail.of("socket:blocked").length === 1, "the block record");
      const limited = abuseTrail.entries.filter((e) => e.outcome === "rate_limited");
      assert.ok(limited.length >= 1 && limited.length <= 3, `one record per incident line, got ${limited.length}`);
      assert.equal(limited[0].action, "chat:message");
      assert.match(limited[0].detail ?? "", /^dropped=\d+$/);
      const [blocked] = abuseTrail.of("socket:blocked");
      assert.equal(blocked.outcome, "blocked");
      assert.equal(blocked.userId, "user-bot");
      assert.equal(blocked.ip, "198.51.100.66");
      assert.equal(blocked.userAgent, "flood-bot/1.0");

      const again = connect(url, options);
      await new Promise<void>((resolve) => again.on("connect_error", () => resolve()));
      again.disconnect();
      await waitUntil(() => abuseTrail.entries.some((e) => e.action === "socket:handshake" && e.outcome === "blocked"), "the refused reconnection");
    } finally {
      await io.close();
    }
  });
});
