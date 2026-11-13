import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { CreateRoom } from "../src/application/usecases/CreateRoom.js";
import { buildRouter, errorHandler } from "../src/infrastructure/http/routes.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";
import { silentAudit, stubTokenVerifier } from "./support/auth.js";

let server: Server;
let base: string;
const created: string[] = [];

before(async () => {
  const rooms = new InMemoryRoomRepository();
  const app = express();
  app.use(express.json());
  app.use(
    buildRouter({
      auth: { verifier: stubTokenVerifier, audit: silentAudit },
      createRoom: new CreateRoom(rooms),
      rooms,
      onRoomCreated: (room) => created.push(room.code),
    }),
  );
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Signed in as the registered user "host" (see stubTokenVerifier). */
const AUTHORIZATION = { authorization: "Bearer user:host" };

function post(path: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTHORIZATION },
    body,
  });
}

describe("HTTP API", () => {
  it("POST /api/rooms creates a room with the trimmed display name", async () => {
    const response = await post("/api/rooms", JSON.stringify({ displayName: "  Ana  " }));
    assert.equal(response.status, 201);
    const room = (await response.json()) as { code: string; hostId: string; players: { displayName: string }[] };
    assert.equal(room.players[0].displayName, "Ana");
    assert.equal(room.hostId, "host", "the host is the user in the token");

    const fetched = await fetch(`${base}/api/rooms/${room.code.toLowerCase()}`, { headers: AUTHORIZATION });
    assert.equal(fetched.status, 200);
    assert.ok(created.includes(room.code), "the created room was not handed over for reaping");
  });

  it("POST /api/rooms rejects invalid display names with 400 INVALID_PLAYER", async () => {
    const invalid = [{}, { displayName: "   " }, { displayName: "n".repeat(33) }, { displayName: 5 }];
    for (const body of invalid) {
      const response = await post("/api/rooms", JSON.stringify(body));
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(((await response.json()) as { code: string }).code, "INVALID_PLAYER");
    }
  });

  it("answers 400 with a JSON error, not 500, when the body is malformed JSON", async () => {
    const response = await post("/api/rooms", '{"displayName": ');
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Malformed JSON body" });
  });

  it("keeps the 4xx status of other middleware errors (payload too large)", async () => {
    const response = await post("/api/rooms", JSON.stringify({ displayName: "x".repeat(200_000) }));
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "Invalid request" });
  });
});
