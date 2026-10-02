import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { CreateRoom } from "../src/application/usecases/CreateRoom.js";
import { buildRouter, errorHandler } from "../src/infrastructure/http/routes.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";

let server: Server;
let base: string;

before(async () => {
  const rooms = new InMemoryRoomRepository();
  const app = express();
  app.use(express.json());
  app.use(buildRouter({ createRoom: new CreateRoom(rooms), rooms }));
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(path: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
}

describe("HTTP API", () => {
  it("POST /api/rooms creates a room with the trimmed display name", async () => {
    const response = await post("/api/rooms", JSON.stringify({ hostId: "host", displayName: "  Ana  " }));
    assert.equal(response.status, 201);
    const room = (await response.json()) as { code: string; players: { displayName: string }[] };
    assert.equal(room.players[0].displayName, "Ana");

    const fetched = await fetch(`${base}/api/rooms/${room.code.toLowerCase()}`);
    assert.equal(fetched.status, 200);
  });

  it("POST /api/rooms rejects invalid identities with 400 INVALID_PLAYER", async () => {
    const invalid = [
      {},
      { hostId: "host" },
      { hostId: "", displayName: "Ana" },
      { hostId: " host", displayName: "Ana" },
      { hostId: "host", displayName: "   " },
      { hostId: "host", displayName: "n".repeat(33) },
      { hostId: 5, displayName: "Ana" },
    ];
    for (const body of invalid) {
      const response = await post("/api/rooms", JSON.stringify(body));
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(((await response.json()) as { code: string }).code, "INVALID_PLAYER");
    }
  });
});
