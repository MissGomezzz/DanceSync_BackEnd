import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Room } from "../src/domain/model/Room.js";
import { ok, record, rejected, SocketHarness, waitUntil } from "./support/socketHarness.js";
import { pickSong, readyUp } from "./support/ready.js";

const harness = new SocketHarness();

before(() => harness.start());
after(() => harness.stop());

describe("Client payload validation over Socket.IO", () => {
  it("room:join rejects malformed identities with INVALID_PLAYER and stores nothing", async () => {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const socket = await harness.client();
    const invalid = [
      { roomCode: code, playerId: "", displayName: "Ghost" },
      { roomCode: code, playerId: "   ", displayName: "Ghost" },
      { roomCode: code, playerId: 12, displayName: "Ghost" },
      { roomCode: code, playerId: "p".repeat(65), displayName: "Ghost" },
      { roomCode: code, playerId: "ghost", displayName: "" },
      { roomCode: code, playerId: "ghost", displayName: { evil: true } },
      { roomCode: code, playerId: "ghost", displayName: "n".repeat(33) },
    ];
    for (const payload of invalid) await rejected(socket, "room:join", payload, "INVALID_PLAYER");
    assert.deepEqual((await harness.storedRoom(code)).players.map((p) => p.id), ["host"]);

    // The socket stayed unbound: it cannot act in the room.
    await rejected(socket, "chat:message", { roomCode: code, senderId: "", content: "hi" }, "PLAYER_NOT_IN_ROOM");

    const room = await ok<Room>(socket, "room:join", { roomCode: code, playerId: "ghost", displayName: "  Casper  " });
    assert.equal(room.players.find((p) => p.id === "ghost")?.displayName, "Casper");
  });

  it("room:join with a missing payload or a non-text room code is a clean error, not a crash", async () => {
    const socket = await harness.client();
    await rejected(socket, "room:join", { roomCode: 123, playerId: "p", displayName: "P" }, "ROOM_NOT_FOUND");
    await rejected(socket, "room:join", null, "ROOM_NOT_FOUND");
    // No payload and no ack at all: reported through error:domain.
    const errors = record<{ code: string }>(socket, "error:domain");
    socket.emit("room:join");
    await waitUntil(() => errors.length === 1, "error:domain");
    assert.equal(errors[0].code, "ROOM_NOT_FOUND");
  });

  it("role:select, chat:message and battle:start check the runtime types of their fields", async () => {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const host = await harness.client();
    const guest = await harness.client();
    await ok(host, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    await ok(guest, "room:join", { roomCode: code, playerId: "guest", displayName: "Guest" });

    await rejected(host, "role:select", { roomCode: code, playerId: "host", role: "admin" }, "INVALID_MESSAGE");
    await rejected(host, "role:select", { roomCode: code, playerId: "host", role: ["dancer"] }, "INVALID_MESSAGE");
    await rejected(host, "chat:message", { roomCode: code, senderId: "host", content: { text: "hi" } }, "INVALID_MESSAGE");
    await rejected(host, "chat:message", { roomCode: code, senderId: "host", content: 42 }, "INVALID_MESSAGE");
    await rejected(host, "battle:start", { roomCode: code, requesterId: "host", dancerIds: "host,guest" }, "INVALID_DANCER");
    await rejected(host, "battle:start", { roomCode: code, requesterId: "host", dancerIds: ["host", 7] }, "INVALID_DANCER");

    const stored = await harness.storedRoom(code);
    assert.equal(stored.status, "waiting");
    assert.ok(stored.players.every((p) => p.role === "undecided"));

    await readyUp(code, { host, guest });
    await pickSong(harness.rooms, code);
    const room = await ok<Room>(host, "battle:start", { roomCode: code, requesterId: "host", dancerIds: ["host", "guest"] });
    assert.equal(room.status, "battling");
  });
});
