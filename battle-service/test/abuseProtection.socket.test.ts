import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import type { AbuseAuditLog, AbuseIncident } from "../src/infrastructure/abuse/abuseAudit.js";
import type { AbuseConfig } from "../src/infrastructure/abuse/abuseConfig.js";
import {
  attachAbuseProtection,
  BLOCKED,
  RATE_BLOCKED_EVENT,
  type RateBlockedPayload,
} from "../src/infrastructure/abuse/abuseProtection.js";
import { InMemoryBlockList, type BlockList } from "../src/infrastructure/abuse/blockList.js";
import { RedisBlockList } from "../src/infrastructure/redis/RedisBlockList.js";
import { waitUntil } from "./support/socketHarness.js";

const CONFIG: AbuseConfig = {
  eventsPerSecond: 20,
  eventBurst: 40,
  strikeThreshold: 40,
  strikeWindowSeconds: 10,
  blockSeconds: 30,
  // The clients below send X-Forwarded-For as a load balancer would, to look like different machines.
  trustedProxyHops: 1,
};

class RecordingAudit implements AbuseAuditLog {
  readonly lines: Array<{ kind: string } & AbuseIncident> = [];
  limited = (i: AbuseIncident) => void this.lines.push({ kind: "limited", ...i });
  blocked = (i: AbuseIncident) => void this.lines.push({ kind: "blocked", ...i });
  refused = (i: AbuseIncident) => void this.lines.push({ kind: "refused", ...i });
  of(kind: string, playerId?: string) {
    return this.lines.filter((l) => l.kind === kind && (playerId === undefined || l.playerId === playerId));
  }
}

/** A Socket.IO server with SEG-3 and a trivial `ping` handler; the handshake trusts the player id it is given. */
class AbuseServer {
  readonly audit = new RecordingAudit();
  io!: Server;
  url = "";
  private http!: HttpServer;
  private readonly clients: ClientSocket[] = [];

  async start(blocks: BlockList, config: Partial<AbuseConfig> = {}): Promise<this> {
    this.http = createServer();
    this.io = new Server(this.http, { path: "/socket.io" });
    // Stand-in for the SEG-1 handshake authentication, which runs before the abuse protection.
    this.io.use((socket, next) => {
      const playerId = socket.handshake.auth?.playerId;
      if (typeof playerId === "string") socket.data.auth = { kind: "user", playerId };
      socket.data.correlationId = `corr-${playerId}`;
      next();
    });
    attachAbuseProtection(this.io, { config: { ...CONFIG, ...config }, blocks, audit: this.audit });
    this.io.on("connection", (socket) => {
      socket.on("ping", (_p: unknown, ack?: (r: unknown) => void) => ack?.({ ok: true, data: null }));
    });
    await new Promise<void>((resolve) => this.http.listen(0, resolve));
    this.url = `http://localhost:${(this.http.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.disconnect();
    await this.io.close();
  }

  open(playerId: string, ip: string): ClientSocket {
    const socket = connect(this.url, {
      path: "/socket.io",
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      auth: { playerId },
      extraHeaders: { "x-forwarded-for": ip },
    });
    this.clients.push(socket);
    return socket;
  }

  /** Resolves "connected", or the refusal message and its data. */
  attempt(playerId: string, ip: string): Promise<{ connected: boolean; message?: string; data?: any; socket: ClientSocket }> {
    const socket = this.open(playerId, ip);
    return new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error(`no answer to the handshake of ${playerId}`)), 3_000);
      socket.on("connect", () => resolve({ connected: true, socket }));
      socket.on("connect_error", (error: Error & { data?: unknown }) =>
        resolve({ connected: false, message: error.message, data: error.data, socket }),
      );
    });
  }

  async connected(playerId: string, ip: string): Promise<ClientSocket> {
    const result = await this.attempt(playerId, ip);
    assert.equal(result.connected, true, `${playerId} should connect, got ${result.message}`);
    return result.socket;
  }
}

/** Sends `count` events without waiting for anything, like a flooding bot. */
function flood(socket: ClientSocket, count: number): void {
  for (let i = 0; i < count; i += 1) socket.emit("ping", { i }, () => {});
}

function blockedAndClosed(socket: ClientSocket) {
  const notices: RateBlockedPayload[] = [];
  socket.on(RATE_BLOCKED_EVENT, (n: RateBlockedPayload) => notices.push(n));
  // Bounded wait: if the client is never disconnected the test fails in seconds instead of hanging.
  const closed = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the flooding client was never disconnected")), 3_000);
    socket.on("disconnect", () => {
      clearTimeout(timer);
      resolve(performance.now());
    });
  });
  return { notices, closed };
}

describe("Temporary block of flooding clients (SEG-3)", () => {
  const server = new AbuseServer();
  before(() => server.start(new InMemoryBlockList()));
  after(() => server.stop());

  it("limits a client that goes over for a moment but does not block it", async () => {
    const socket = await server.connected("eager", "198.51.100.1");
    flood(socket, 60); // 40 pass, about 20 are dropped: fewer than a whole burst
    await sleep(300);
    assert.equal(socket.connected, true);
    assert.equal(server.audit.of("blocked", "eager").length, 0);
    const limited = server.audit.of("limited", "eager");
    assert.equal(limited.length, 1, "one incident line, not one per dropped event");
    assert.equal(limited[0].ip, "198.51.100.1");
    assert.equal(limited[0].correlationId, "corr-eager");
    assert.equal(limited[0].socketEvent, "ping");
  });

  it("blocks a flooding client within a second, tells it why and closes the connection", async () => {
    const socket = await server.connected("bot", "198.51.100.66");
    const { notices, closed } = blockedAndClosed(socket);
    const started = performance.now();
    flood(socket, 200);
    const closedAt = await closed;
    assert.ok(closedAt - started < 1_000, `closed after ${(closedAt - started).toFixed(0)} ms`);
    assert.equal(notices.length, 1, "rate:blocked arrives before the connection closes");
    assert.equal(notices[0].code, BLOCKED);
    assert.equal(notices[0].retryAfterMs, 30_000);

    const blocked = server.audit.of("blocked", "bot");
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].ip, "198.51.100.66");
    assert.equal(blocked[0].blockedForMs, 30_000);
    assert.ok(server.audit.of("limited", "bot").length <= 2, "the incident log is not flooded too");
  });

  it("refuses the blocked identity and the blocked address at the handshake, on any connection", async () => {
    // Same player from another address (a new network).
    const samePlayer = await server.attempt("bot", "203.0.113.5");
    assert.equal(samePlayer.connected, false);
    assert.equal(samePlayer.message, BLOCKED);
    assert.ok(samePlayer.data.retryAfterMs > 25_000 && samePlayer.data.retryAfterMs <= 30_000);
    // Another identity from the same address (a fresh guest token).
    const sameAddress = await server.attempt("fresh-guest", "198.51.100.66");
    assert.equal(sameAddress.connected, false);
    assert.equal(sameAddress.message, BLOCKED);
    // Everybody else is unaffected.
    const other = await server.attempt("normal", "198.51.100.2");
    assert.equal(other.connected, true);

    const refused = server.audit.of("refused");
    assert.equal(refused.length, 2);
    assert.ok(refused.every((r) => r.socketEvent === "handshake" && (r.blockedForMs ?? 0) > 0));
  });
});

describe("Block expiry and block list failures (SEG-3)", () => {
  it("lets the client back once the block expires", async () => {
    const server = await new AbuseServer().start(new InMemoryBlockList(), { blockSeconds: 0.3 });
    try {
      const socket = await server.connected("bot", "198.51.100.66");
      const { closed } = blockedAndClosed(socket);
      flood(socket, 200);
      await closed;
      assert.equal((await server.attempt("bot", "198.51.100.66")).connected, false);
      await sleep(400);
      assert.equal((await server.attempt("bot", "198.51.100.66")).connected, true);
    } finally {
      await server.stop();
    }
  });

  it("accepts connections when the block list cannot be read, and still disconnects a flooder", async () => {
    const broken: BlockList = {
      block: async () => {
        throw new Error("Redis is down");
      },
      remainingMs: async () => {
        throw new Error("Redis is down");
      },
    };
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    const server = await new AbuseServer().start(broken);
    try {
      const socket = await server.connected("bot", "198.51.100.66");
      const { closed } = blockedAndClosed(socket);
      flood(socket, 200);
      await closed;
      assert.ok(errors.length >= 2, "both failures are logged");
    } finally {
      console.error = original;
      await server.stop();
    }
  });
});

describe("Block shared by two instances through Redis (SEG-3)", { skip: !process.env.TEST_REDIS_URL && "TEST_REDIS_URL is not set" }, () => {
  let redis: Redis;
  const prefix = `test:block:${randomUUID().slice(0, 8)}:`;
  const one = new AbuseServer();
  const two = new AbuseServer();

  before(async () => {
    redis = new Redis(process.env.TEST_REDIS_URL!);
    await one.start(new RedisBlockList(redis, prefix));
    await two.start(new RedisBlockList(redis, prefix));
  });

  after(async () => {
    await one.stop();
    await two.stop();
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("a client blocked by one instance is refused by the other", async () => {
    const socket = await one.connected("bot", "198.51.100.66");
    const { closed } = blockedAndClosed(socket);
    flood(socket, 200);
    await closed;
    await waitUntil(() => one.audit.of("blocked", "bot").length === 1, "the block");

    const elsewhere = await two.attempt("bot", "203.0.113.5");
    assert.equal(elsewhere.connected, false, "refused by the instance that never saw the flood");
    assert.equal(elsewhere.message, BLOCKED);
    assert.equal(two.audit.of("refused", "bot").length, 1);
    assert.equal((await two.attempt("normal", "198.51.100.2")).connected, true);
  });
});
