import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ChatMessage } from "../src/domain/model/ChatMessage.js";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import {
  FakeEntra,
  guestToken,
  RecordingAudit,
  tamperedPayload,
  TEST_CLIENT_ID,
  unsignedToken,
} from "./support/auth.js";
import { consoleAuthAudit } from "../src/infrastructure/auth/authAudit.js";
import { emit, ok, rejected, SocketHarness } from "./support/socketHarness.js";

/**
 * SEG-1 (security, authentication) over Socket.IO: the token travels in the
 * handshake and the battle-service validates it before accepting the
 * connection. Runs against the real validation (JwtTokenVerifier fetching the
 * tenant's keys from a JWKS endpoint), with the six token cases of the
 * scenario: absent, expired, tampered, issued for another audience, guest
 * outside its scope, and valid.
 */
const entra = new FakeEntra();
const audit = new RecordingAudit();
const harness = new SocketHarness();

before(async () => {
  await entra.start();
  await harness.start({ auth: { verifier: entra.verifier(), audit, guestIssuer: entra.guestIssuer() } });
});
after(async () => {
  await harness.stop();
  await entra.stop();
});
beforeEach(() => {
  audit.entries.length = 0;
});

async function newRoom(hostId = "user-ana"): Promise<string> {
  return (await harness.createRoom.execute({ hostId, displayName: "Ana" })).code;
}

/** Asks the service for a guest token like the frontend does. */
async function guestSession(code: string, displayName = "Invitado"): Promise<{ token: string; playerId: string }> {
  const response = await fetch(`${harness.baseUrl}/api/rooms/${code}/guest-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { token: string; playerId: string };
}

/** The handshake must be refused with UNAUTHORIZED, leave no socket behind and be recorded once. */
async function assertHandshakeRefused(token: string | undefined, reason: string): Promise<void> {
  const socketsBefore = harness.io.of("/").sockets.size;
  const correlationId = `seg1-${reason}`;
  const { error, socket } = await harness.refusedClient(token === undefined ? undefined : { token }, {
    "x-correlation-id": correlationId,
  });

  assert.equal(error.message, "UNAUTHORIZED");
  assert.deepEqual(error.data, { code: "UNAUTHORIZED", message: "A valid access token is required", correlationId });
  assert.equal(socket.connected, false);
  await sleep(20);
  assert.equal(harness.io.of("/").sockets.size, socketsBefore, "a refused handshake left a socket on the server");

  assert.deepEqual(audit.entries, [
    { channel: "socket.io", code: "UNAUTHORIZED", reason, correlationId, socketEvent: "handshake" },
  ]);
  if (token) assert.ok(!audit.serialized().includes(token), "the audit log contains the token");
}

describe("SEG-1 Socket.IO: the handshake is refused without a valid token", () => {
  it("case 1, absent token: UNAUTHORIZED, and the socket never reaches a room", async () => {
    const code = await newRoom();
    await assertHandshakeRefused(undefined, "missing_token");
    // Also when the field is there but empty or not a string.
    for (const auth of [{ token: "" }, { token: 42 }, { token: null }]) {
      const { error } = await harness.refusedClient(auth);
      assert.equal(error.message, "UNAUTHORIZED");
    }
    assert.deepEqual((await harness.storedRoom(code)).players.map((p) => p.id), ["user-ana"]);
  });

  it("case 2, expired token: UNAUTHORIZED", async () => {
    await assertHandshakeRefused(await entra.token({ expiresInSeconds: -3600 }), "expired_token");
  });

  it("case 3, tampered token: UNAUTHORIZED (edited payload, foreign signature, no signature, garbage)", async () => {
    const valid = await entra.token({ oid: "user-mallory" });
    // The attacker rewrites the payload to become another user and keeps the old signature.
    await assertHandshakeRefused(tamperedPayload(valid, { oid: "user-ana" }), "invalid_signature");
    audit.entries.length = 0;
    // Every claim is right but the token was signed with a key that is not the tenant's.
    await assertHandshakeRefused(await entra.forgedToken({ oid: "user-ana" }), "invalid_signature");
    audit.entries.length = 0;
    // "alg: none": the signature was removed altogether.
    await assertHandshakeRefused(unsignedToken(valid), "invalid_signature");
    audit.entries.length = 0;
    await assertHandshakeRefused("not.a.jwt", "malformed_token");
  });

  it("case 4, token issued for another audience: UNAUTHORIZED", async () => {
    const otherApi = "99999999-9999-4999-8999-999999999999";
    await assertHandshakeRefused(await entra.token({ audience: otherApi }), "wrong_audience");
  });

  it("a token from another issuer (another tenant) is refused too", async () => {
    const otherTenant = "https://login.microsoftonline.com/33333333-3333-4333-8333-333333333333/v2.0";
    await assertHandshakeRefused(await entra.token({ issuer: otherTenant }), "wrong_issuer");
  });

  it("an expired guest token, or one signed with another secret, is refused", async () => {
    const code = await newRoom();
    await assertHandshakeRefused(await guestToken({ roomCode: code, expiresInSeconds: -3600 }), "expired_token");
    audit.entries.length = 0;
    const otherSecret = new TextEncoder().encode("another-secret-that-is-32-bytes-long!!!");
    await assertHandshakeRefused(await guestToken({ roomCode: code, secret: otherSecret }), "invalid_signature");
  });
});

describe("SEG-1 Socket.IO: a guest token is valid only for its room", () => {
  it("case 5, guest outside its scope: joining another room is FORBIDDEN and binds nothing", async () => {
    const own = await newRoom("user-ana");
    const other = await newRoom("user-beto");
    const { token, playerId } = await guestSession(own);
    const guest = await harness.client(token);

    await rejected(guest, "room:join", { roomCode: other, displayName: "Invitado" }, "FORBIDDEN");
    assert.deepEqual((await harness.storedRoom(other)).players.map((p) => p.id), ["user-beto"]);
    // Not bound to the other room: it can neither act there nor read its events.
    await rejected(guest, "chat:message", { roomCode: other, content: "hola" }, "PLAYER_NOT_IN_ROOM");
    assert.equal(harness.io.of("/").adapter.rooms.get(other), undefined, "the guest subscribed to the other room");

    assert.equal(audit.entries.length, 1);
    const { correlationId, ...recorded } = audit.entries[0];
    assert.deepEqual(recorded, {
      channel: "socket.io",
      code: "FORBIDDEN",
      reason: "guest_out_of_scope",
      socketEvent: "room:join",
    });
    assert.match(correlationId, /^[A-Za-z0-9._-]{1,64}$/);
    assert.ok(!audit.serialized().includes(token), "the audit log contains the token");

    // The same token still works where it is valid.
    const room = await ok<RoomDto>(guest, "room:join", { roomCode: own });
    assert.deepEqual(room.players.map((p) => p.id), ["user-ana", playerId]);
  });

  it("a guest joins its own room, under the id and name carried by the token", async () => {
    const code = await newRoom();
    const { token, playerId } = await guestSession(code, "  Lucía  ");
    assert.match(playerId, /^guest-[0-9a-f-]{36}$/);
    const guest = await harness.client(token);

    const room = await ok<RoomDto>(guest, "room:join", { roomCode: code.toLowerCase() });
    assert.deepEqual(room.players.at(-1), { id: playerId, displayName: "Lucía", role: "undecided", ready: false });
    const message = await ok<ChatMessage>(guest, "chat:message", { roomCode: code, content: "hola" });
    assert.equal(message.senderId, playerId);
    assert.equal(audit.entries.length, 0);
  });
});

describe("SEG-1 Socket.IO: with a valid token, the player is the one in the token", () => {
  it("case 6, valid token: the connection is accepted and room:join seats the token's user", async () => {
    const code = await newRoom("user-ana");
    const beto = await harness.client(await entra.token({ oid: "user-beto", name: "Beto" }));

    // No player id in the payload at all: the server takes it from the token.
    const room = await ok<RoomDto>(beto, "room:join", { roomCode: code });
    assert.deepEqual(
      room.players.map((p) => [p.id, p.displayName]),
      [
        ["user-ana", "Ana"],
        ["user-beto", "Beto"],
      ],
    );
    const message = await ok<ChatMessage>(beto, "chat:message", { roomCode: code, content: "listo" });
    assert.equal(message.senderId, "user-beto");
    assert.equal(audit.entries.length, 0, "a valid connection was recorded as a rejection");
  });

  it("an id sent by the client cannot change who acts: not on room:join, not afterwards", async () => {
    const code = await newRoom("user-ana");
    const ana = await harness.client(await entra.token({ oid: "user-ana" }));
    const mallory = await harness.client(await entra.token({ oid: "user-mallory", name: "Mallory" }));
    await ok(ana, "room:join", { roomCode: code });

    // Claiming to be the host on room:join: seated as herself, the host's seat is untouched.
    const room = await ok<RoomDto>(mallory, "room:join", { roomCode: code, playerId: "user-ana", displayName: "Mallory" });
    assert.deepEqual(room.players.map((p) => p.id), ["user-ana", "user-mallory"]);
    assert.equal(room.hostId, "user-ana");

    // Naming the host in any later event is refused...
    await rejected(mallory, "battle:start", { roomCode: code, requesterId: "user-ana" }, "PLAYER_NOT_IN_ROOM");
    await rejected(mallory, "chat:message", { roomCode: code, senderId: "user-ana", content: "soy Ana" }, "PLAYER_NOT_IN_ROOM");
    await rejected(mallory, "room:leave", { roomCode: code, playerId: "user-ana" }, "PLAYER_NOT_IN_ROOM");
    // ...and without an id she acts as herself, so host-only actions answer NOT_HOST.
    await rejected(mallory, "player:kick", { roomCode: code, playerId: "user-ana" }, "NOT_HOST");
    assert.deepEqual((await harness.storedRoom(code)).players.map((p) => p.id), ["user-ana", "user-mallory"]);
  });

  it("the tenant's keys are downloaded once and reused for the following handshakes", async () => {
    const before = entra.jwksRequests;
    for (const oid of ["user-1", "user-2", "user-3"]) await harness.client(await entra.token({ oid }));
    assert.ok(entra.jwksRequests - before <= 1, "the key set was fetched for every handshake");
  });
});

describe("SEG-1 Socket.IO: 100 % of the connections without a valid token are refused", () => {
  it("none of the invalid tokens gets a connection, a seat or an event through", async () => {
    const code = await newRoom();
    const valid = await entra.token({ oid: "user-mallory" });
    const invalid: (string | undefined)[] = [
      undefined,
      "",
      "garbage",
      await entra.token({ expiresInSeconds: -3600 }),
      tamperedPayload(valid, { oid: "user-ana" }),
      await entra.forgedToken(),
      unsignedToken(valid),
      await entra.token({ audience: `api://${TEST_CLIENT_ID}-other` }),
      await entra.token({ issuer: "https://evil.example/v2.0" }),
      await guestToken({ roomCode: code, expiresInSeconds: -3600 }),
      await guestToken({ roomCode: code, audience: "another-audience" }),
    ];
    const socketsBefore = harness.io.of("/").sockets.size;

    for (const token of invalid) {
      const { error, socket } = await harness.refusedClient(token === undefined ? undefined : { token });
      assert.equal(error.message, "UNAUTHORIZED");
      // Whatever a refused client emits goes nowhere: it is not connected.
      const answer = await Promise.race([emit(socket, "room:join", { roomCode: code, playerId: "user-ana" }), sleep(50, null)]);
      assert.equal(answer, null, "a refused socket got an answer to room:join");
    }

    assert.equal(audit.entries.length, invalid.length, "every refusal is recorded");
    assert.ok(audit.entries.every((entry) => entry.code === "UNAUTHORIZED" && entry.correlationId.length > 0));
    assert.equal(harness.io.of("/").sockets.size, socketsBefore);
    assert.deepEqual((await harness.storedRoom(code)).players.map((p) => p.id), ["user-ana"]);
  });
});

describe("SEG-1: the audit line written to the log", () => {
  it("is one JSON line named auth.rejected with the correlation id, and nothing but what the entry carries", (t) => {
    const lines: string[] = [];
    t.mock.method(console, "warn", (line: string) => lines.push(line));

    consoleAuthAudit.rejected({
      channel: "socket.io",
      code: "UNAUTHORIZED",
      reason: "expired_token",
      correlationId: "abc-123",
      socketEvent: "handshake",
    });

    assert.equal(lines.length, 1);
    const { at, ...line } = JSON.parse(lines[0]) as Record<string, string>;
    assert.deepEqual(line, {
      level: "warn",
      event: "auth.rejected",
      channel: "socket.io",
      code: "UNAUTHORIZED",
      reason: "expired_token",
      correlationId: "abc-123",
      socketEvent: "handshake",
    });
    assert.ok(!Number.isNaN(Date.parse(at)));
  });
});
