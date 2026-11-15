import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import type { ChatMessage } from "../src/domain/model/ChatMessage.js";
import {
  attachEventRateLimit,
  RATE_LIMITED,
  RATE_LIMITED_EVENT,
  type DroppedEvent,
  type RateLimitedPayload,
} from "../src/infrastructure/abuse/eventRateLimit.js";
import { emit, ok, record, SocketHarness, waitUntil, type AckResponse } from "./support/socketHarness.js";

/** Sends `count` events at once and resolves every acknowledgement. */
function flood(socket: ClientSocket, count: number, event = "ping"): Promise<Array<AckResponse<unknown>>> {
  return Promise.all(Array.from({ length: count }, (_, i) => emit<unknown>(socket, event, { i })));
}

const accepted = (acks: Array<AckResponse<unknown>>) => acks.filter((a) => a.ok).length;
const limited = (acks: Array<AckResponse<unknown>>) =>
  acks.filter((a) => !a.ok && a.error.code === RATE_LIMITED).length;

describe("Event rate limit per connection (SEG-3)", () => {
  let http: HttpServer;
  let io: Server;
  let url: string;
  const clients: ClientSocket[] = [];
  const dropped: DroppedEvent[] = [];
  let handled = 0;

  before(async () => {
    http = createServer();
    io = new Server(http, { path: "/socket.io" });
    attachEventRateLimit(io, { eventsPerSecond: 20, eventBurst: 40, onDropped: (d) => dropped.push(d) });
    io.on("connection", (socket) => {
      socket.on("ping", (_payload: unknown, ack: (r: unknown) => void) => {
        handled += 1;
        ack({ ok: true, data: null });
      });
    });
    await new Promise<void>((resolve) => http.listen(0, resolve));
    url = `http://localhost:${(http.address() as AddressInfo).port}`;
  });

  after(async () => {
    for (const c of clients) c.disconnect();
    await io.close();
  });

  async function client(): Promise<ClientSocket> {
    const socket = connect(url, { path: "/socket.io", transports: ["websocket"], forceNew: true });
    clients.push(socket);
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    return socket;
  }

  it("lets a legitimate burst of 40 events through untouched", async () => {
    const socket = await client();
    const notices = record<RateLimitedPayload>(socket, RATE_LIMITED_EVENT);
    const acks = await flood(socket, 40);
    assert.equal(accepted(acks), 40);
    await sleep(50);
    assert.equal(notices.length, 0, "no rate:limited notice for a burst within the limit");
  });

  it("accepts a client that stays below the sustained rate", async () => {
    const socket = await client();
    await flood(socket, 40); // empty the burst first: only the sustained rate is left
    await sleep(2_100); // and let it refill
    let refused = 0;
    for (let i = 0; i < 30; i += 1) {
      const ack = await emit(socket, "ping", { i });
      if (!ack.ok) refused += 1;
      await sleep(66); // about 15 events per second, under 20
    }
    assert.equal(refused, 0);
  });

  it("drops a flood within the first second, answers every refused event at once and tells the client", async () => {
    const socket = await client();
    const notices = record<RateLimitedPayload>(socket, RATE_LIMITED_EVENT);
    const handledBefore = handled;
    const droppedBefore = dropped.length;
    const started = performance.now();
    const acks = await flood(socket, 200);
    const elapsed = performance.now() - started;

    assert.ok(accepted(acks) >= 40 && accepted(acks) <= 42, `accepted ${accepted(acks)}: the burst, maybe one refilled token`);
    assert.equal(limited(acks), 200 - accepted(acks), "every other event is answered RATE_LIMITED");
    assert.equal(handled - handledBefore, accepted(acks), "refused events never reach the handler");
    assert.ok(elapsed < 1_000, `all 200 acknowledgements arrived in ${elapsed.toFixed(0)} ms`);

    await waitUntil(() => notices.length > 0, "rate:limited notice");
    assert.equal(notices[0].code, RATE_LIMITED);
    assert.ok(notices[0].retryAfterMs > 0 && notices[0].retryAfterMs <= 50);
    assert.equal(notices.length, 1, "one notice per second, not one per dropped event");
    assert.equal(dropped.length - droppedBefore, limited(acks), "every refused event is reported for the incident log");
    assert.ok(dropped.slice(droppedBefore).every((d) => d.event === "ping"));
  });

  it("drops events without acknowledgement too, silently for the handler", async () => {
    const socket = await client();
    const handledBefore = handled;
    for (let i = 0; i < 100; i += 1) socket.emit("ping", { i }, () => {});
    for (let i = 0; i < 20; i += 1) socket.emit("ping", { i }); // no ack: nothing to answer
    await sleep(200);
    assert.ok(handled - handledBefore <= 45, `handled ${handled - handledBefore}`);
  });

  it("limits each connection on its own: a flooding client does not slow down another", async () => {
    const abusive = await client();
    const normal = await client();
    const floodDone = flood(abusive, 300);
    const acks = await flood(normal, 30);
    await floodDone;
    assert.equal(accepted(acks), 30);
  });

  it("lets a limited client send again once its bucket refills", async () => {
    const socket = await client();
    await flood(socket, 100);
    assert.equal((await emit(socket, "ping", {})).ok, false);
    await sleep(150); // at 20 per second, two tokens or more
    assert.equal((await emit(socket, "ping", {})).ok, true);
  });
});

describe("Event rate limit with the real battle-service handlers (SEG-3)", () => {
  const harness = new SocketHarness();
  before(async () => {
    await harness.start();
    attachEventRateLimit(harness.io, { eventsPerSecond: 20, eventBurst: 40 });
  });
  after(() => harness.stop());

  it("a player flooding the chat is limited while the rest of the room keeps chatting", async () => {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const host = await harness.client();
    const flooder = await harness.client();
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await ok(flooder, "room:join", { roomCode: code, playerId: "bot", displayName: "Bot" });
    const seenByHost = record<ChatMessage>(host, "chat:message");

    const acks = await Promise.all(
      Array.from({ length: 150 }, (_, i) =>
        emit<ChatMessage>(flooder, "chat:message", { roomCode: code, senderId: "bot", content: `spam ${i}` }),
      ),
    );
    const delivered = accepted(acks);
    // The two room:join of this test already took a token from each bucket.
    assert.ok(delivered >= 38 && delivered <= 41, `delivered ${delivered}`);
    assert.equal(limited(acks), 150 - delivered);

    const message = await ok<ChatMessage>(host, "chat:message", { roomCode: code, senderId: "host", content: "still here" });
    assert.equal(message.content, "still here");
    await waitUntil(() => seenByHost.some((m) => m.content === "still here"), "the host's own message");
    assert.equal(seenByHost.filter((m) => m.senderId === "bot").length, delivered, "only accepted messages are broadcast");
  });
});
