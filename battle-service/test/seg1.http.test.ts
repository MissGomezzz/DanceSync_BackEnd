import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import {
  FakeEntra,
  guestToken,
  RecordingAudit,
  tamperedPayload,
  unsignedToken,
} from "./support/auth.js";
import { ok, SocketHarness } from "./support/socketHarness.js";

/**
 * SEG-1 (security, authentication) over HTTP, on the battle-service routes.
 * The api-gateway refuses these requests first (see its Seg1SecurityTests);
 * the service validates the token again, so it is safe when reached directly
 * and the player id comes from the token, never from the body.
 */
const entra = new FakeEntra();
const audit = new RecordingAudit();
const harness = new SocketHarness();

before(async () => {
  await entra.start();
  await harness.start({ auth: { verifier: entra.verifier(), audit, guestIssuer: entra.guestIssuer(600) } });
});
after(async () => {
  await harness.stop();
  await entra.stop();
});
beforeEach(() => {
  audit.entries.length = 0;
});

interface Call {
  method?: string;
  token?: string;
  body?: unknown;
  correlationId?: string;
}

function call(path: string, { method = "GET", token, body, correlationId }: Call = {}): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(correlationId ? { "x-correlation-id": correlationId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const createRoom = (token?: string, correlationId?: string) =>
  call("/api/rooms", { method: "POST", token, body: { displayName: "Ana", hostId: "user-victim" }, correlationId });

async function newRoom(hostId = "user-ana"): Promise<string> {
  return (await harness.createRoom.execute({ hostId, displayName: "Ana" })).code;
}

async function guestSession(code: string): Promise<{ token: string; playerId: string; roomCode: string; expiresAt: string }> {
  const response = await call(`/api/rooms/${code}/guest-token`, { method: "POST", body: { displayName: "Invitado" } });
  assert.equal(response.status, 201);
  return (await response.json()) as { token: string; playerId: string; roomCode: string; expiresAt: string };
}

/** The request must be answered 401, change nothing and be recorded once, without the token. */
async function assertUnauthorized(token: string | undefined, reason: string): Promise<void> {
  const roomsBefore = (await harness.rooms.listCodes()).length;
  const correlationId = `seg1-http-${reason}`;
  const response = await createRoom(token, correlationId);

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
  assert.equal(response.headers.get("x-correlation-id"), correlationId);
  assert.deepEqual(await response.json(), {
    error: "A valid access token is required",
    code: "UNAUTHORIZED",
    correlationId,
  });
  assert.equal((await harness.rooms.listCodes()).length, roomsBefore, "a refused request created a room");
  assert.deepEqual(audit.entries, [
    { channel: "http", code: "UNAUTHORIZED", reason, correlationId, method: "POST", path: "/api/rooms" },
  ]);
  if (token) assert.ok(!audit.serialized().includes(token), "the audit log contains the token");
}

describe("SEG-1 HTTP (battle-service): creating a room needs a valid Entra ID token", () => {
  it("case 1, absent token: 401", async () => {
    await assertUnauthorized(undefined, "missing_token");
  });

  it("case 2, expired token: 401", async () => {
    await assertUnauthorized(await entra.token({ expiresInSeconds: -3600 }), "expired_token");
  });

  it("case 3, tampered token: 401 (edited payload, foreign signature, no signature)", async () => {
    const valid = await entra.token({ oid: "user-mallory" });
    await assertUnauthorized(tamperedPayload(valid, { oid: "user-ana" }), "invalid_signature");
    audit.entries.length = 0;
    await assertUnauthorized(await entra.forgedToken(), "invalid_signature");
    audit.entries.length = 0;
    await assertUnauthorized(unsignedToken(valid), "invalid_signature");
  });

  it("case 4, token issued for another audience: 401", async () => {
    await assertUnauthorized(await entra.token({ audience: "99999999-9999-4999-8999-999999999999" }), "wrong_audience");
  });

  it("case 5, guest token outside its scope: 403 creating a room or reading another room", async () => {
    const own = await newRoom("user-ana");
    const other = await newRoom("user-beto");
    const { token } = await guestSession(own);
    const roomsBefore = (await harness.rooms.listCodes()).length;

    const create = await createRoom(token, "seg1-http-guest-create");
    assert.equal(create.status, 403);
    assert.deepEqual(await create.json(), {
      error: "Guests cannot do this; sign in first",
      code: "FORBIDDEN",
      correlationId: "seg1-http-guest-create",
    });
    assert.equal((await harness.rooms.listCodes()).length, roomsBefore, "a guest created a room");

    const read = await call(`/api/rooms/${other}`, { token, correlationId: "seg1-http-guest-read" });
    assert.equal(read.status, 403);
    const leave = await call(`/api/rooms/${other}/leave`, { method: "POST", token, correlationId: "seg1-http-guest-leave" });
    assert.equal(leave.status, 403);

    assert.deepEqual(
      audit.entries.map(({ code, reason, correlationId, method, path }) => [code, reason, correlationId, method, path]),
      [
        ["FORBIDDEN", "guest_out_of_scope", "seg1-http-guest-create", "POST", "/api/rooms"],
        ["FORBIDDEN", "guest_out_of_scope", "seg1-http-guest-read", "GET", `/api/rooms/${other}`],
        ["FORBIDDEN", "guest_out_of_scope", "seg1-http-guest-leave", "POST", `/api/rooms/${other}/leave`],
      ],
    );
    assert.ok(!audit.serialized().includes(token), "the audit log contains the token");

    // Inside its scope the same token works.
    assert.equal((await call(`/api/rooms/${own}`, { token })).status, 200);
  });

  it("case 6, valid token: 201, and the host is the user in the token, not the hostId in the body", async () => {
    const response = await createRoom(await entra.token({ oid: "user-ana", name: "Ana" }));
    assert.equal(response.status, 201);
    const room = (await response.json()) as RoomDto;
    assert.equal(room.hostId, "user-ana");
    assert.deepEqual(room.players.map((p) => p.id), ["user-ana"]);
    assert.match(response.headers.get("x-correlation-id") ?? "", /^[A-Za-z0-9._-]{1,64}$/);
    assert.equal(audit.entries.length, 0);
  });

  it("the display name defaults to the name in the token", async () => {
    const response = await call("/api/rooms", { method: "POST", token: await entra.token({ oid: "user-carla", name: "Carla" }), body: {} });
    assert.equal(response.status, 201);
    assert.equal(((await response.json()) as RoomDto).players[0].displayName, "Carla");
  });
});

describe("SEG-1 HTTP (battle-service): guest tokens", () => {
  it("anyone with the code of an existing room gets a short-lived token bound to that room", async () => {
    const code = await newRoom();
    const before = Date.now();
    const guest = await guestSession(code.toLowerCase());

    assert.equal(guest.roomCode, code);
    assert.match(guest.playerId, /^guest-[0-9a-f-]{36}$/);
    const lifetimeMs = new Date(guest.expiresAt).getTime() - before;
    assert.ok(lifetimeMs > 590_000 && lifetimeMs <= 601_000, `expires in ${lifetimeMs} ms`);
    const claims = JSON.parse(Buffer.from(guest.token.split(".")[1], "base64url").toString("utf8"));
    assert.deepEqual(
      { iss: claims.iss, aud: claims.aud, sub: claims.sub, room: claims.room, scope: claims.scope, name: claims.name },
      {
        iss: "dancesync-battle-service",
        aud: "dancesync-guest",
        sub: guest.playerId,
        room: code,
        scope: "guest",
        name: "Invitado",
      },
    );
    // Two guests never share an identity.
    assert.notEqual((await guestSession(code)).playerId, guest.playerId);
  });

  it("no token for a room that does not exist (404) or without a valid display name (400)", async () => {
    const code = await newRoom();
    const unknown = await call("/api/rooms/NOROOM/guest-token", { method: "POST", body: { displayName: "Invitado" } });
    assert.equal(unknown.status, 404);
    for (const body of [{}, { displayName: "   " }, { displayName: "n".repeat(33) }]) {
      const response = await call(`/api/rooms/${code}/guest-token`, { method: "POST", body });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
  });

  it("an expired guest token, or one for another audience, is refused with 401", async () => {
    const code = await newRoom();
    const expired = await call(`/api/rooms/${code}`, { token: await guestToken({ roomCode: code, expiresInSeconds: -3600 }) });
    assert.equal(expired.status, 401);
    const otherAudience = await call(`/api/rooms/${code}`, { token: await guestToken({ roomCode: code, audience: "other" }) });
    assert.equal(otherAudience.status, 401);
    assert.deepEqual(audit.entries.map((entry) => entry.reason), ["expired_token", "wrong_audience"]);
  });
});

describe("SEG-1 HTTP (battle-service): the leave endpoint acts as the player in the token", () => {
  it("leaves as the token's player, with the token in the header or (beacon) in the body", async () => {
    const code = await newRoom("user-ana");
    const betoToken = await entra.token({ oid: "user-beto", name: "Beto" });
    const { token: guest, playerId: guestId } = await guestSession(code);
    await ok(await harness.client(betoToken), "room:join", { roomCode: code });
    await ok(await harness.client(guest), "room:join", { roomCode: code });

    // Naming the host in the body does not make Beto leave as the host.
    const header = await call(`/api/rooms/${code}/leave`, { method: "POST", token: betoToken, body: { playerId: "user-ana" } });
    assert.equal(header.status, 204);
    assert.deepEqual((await harness.storedRoom(code)).players.map((p) => p.id), ["user-ana", guestId]);

    // navigator.sendBeacon cannot set headers: the token travels in a text/plain body.
    const beacon = await fetch(`${harness.baseUrl}/api/rooms/${code}/leave`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ token: guest }),
    });
    assert.equal(beacon.status, 204);
    assert.deepEqual((await harness.storedRoom(code)).players.map((p) => p.id), ["user-ana"]);
  });

  it("without a valid token nobody leaves: 401 and the room is unchanged", async () => {
    const code = await newRoom("user-ana");
    const valid = await entra.token({ oid: "user-ana" });
    for (const body of [{ playerId: "user-ana" }, { token: tamperedPayload(valid, { oid: "user-beto" }) }, { token: "garbage" }]) {
      const response = await call(`/api/rooms/${code}/leave`, { method: "POST", body });
      assert.equal(response.status, 401, JSON.stringify(body));
    }
    assert.deepEqual((await harness.storedRoom(code)).players.map((p) => p.id), ["user-ana"]);
    assert.equal(audit.entries.length, 3);
  });
});

describe("SEG-1 HTTP (battle-service): 100 % of the requests without a valid token are refused", () => {
  it("every protected route answers 401 to every invalid token; only the health check and the guest token are public", async () => {
    const code = await newRoom();
    const valid = await entra.token({ oid: "user-mallory" });
    const invalid: (string | undefined)[] = [
      undefined,
      "garbage",
      await entra.token({ expiresInSeconds: -3600 }),
      tamperedPayload(valid, { oid: "user-ana" }),
      await entra.forgedToken(),
      unsignedToken(valid),
      await entra.token({ audience: "another-api" }),
      await entra.token({ issuer: "https://evil.example/v2.0" }),
    ];
    const routes: [string, string][] = [
      ["POST", "/api/rooms"],
      ["GET", `/api/rooms/${code}`],
      ["POST", `/api/rooms/${code}/leave`],
    ];
    let refused = 0;
    for (const token of invalid) {
      for (const [method, path] of routes) {
        const response = await call(path, { method, token, ...(method === "POST" ? { body: { displayName: "X" } } : {}) });
        assert.equal(response.status, 401, `${method} ${path} with ${token?.slice(0, 12)}`);
        refused += 1;
      }
    }
    assert.equal(refused, invalid.length * routes.length);
    assert.equal(audit.entries.length, refused, "every refusal is recorded");
    assert.ok(audit.entries.every((entry) => /^[A-Za-z0-9._-]{1,64}$/.test(entry.correlationId)));
    assert.deepEqual((await harness.storedRoom(code)).players.map((p) => p.id), ["user-ana"]);

    assert.equal((await call("/api/battles/health")).status, 200);
  });

  it("a correlation id that is not a plain id is replaced, so nothing can be injected into the log", async () => {
    const response = await createRoom(undefined, 'x"}\\n{"event":"forged');
    assert.equal(response.status, 401);
    const { correlationId } = (await response.json()) as { correlationId: string };
    assert.match(correlationId, /^[0-9a-f-]{36}$/);
    assert.equal(audit.entries[0].correlationId, correlationId);
  });
});
