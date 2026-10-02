import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ChatMessage } from "../src/domain/model/ChatMessage.js";
import { ok, record, SocketHarness, waitUntil } from "./support/socketHarness.js";

const harness = new SocketHarness();

before(() => harness.start());
after(() => harness.stop());

describe("Malformed acknowledgement arguments", () => {
  it("a non-function ack neither crashes the server nor breaks later events", async () => {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const socket = await harness.client();
    await ok(socket, "room:join", { roomCode: code, playerId: "host", displayName: "Host" });
    const errors = record<{ code: string }>(socket, "error:domain");
    const messages = record<ChatMessage>(socket, "chat:message");

    // Failing event (impersonation) and succeeding event, both with a string as "ack".
    socket.emit("chat:message", { roomCode: code, senderId: "someone-else", content: "hi" }, "not-a-callback");
    socket.emit("chat:message", { roomCode: code, senderId: "host", content: "still here" }, 42);

    // The failure is reported through the error event, since there is no callback.
    await waitUntil(() => errors.length === 1 && messages.length === 1, "error:domain and the chat broadcast");
    assert.equal(errors[0].code, "PLAYER_NOT_IN_ROOM");
    assert.equal(messages[0].content, "still here");

    // The server (this very process) is alive and keeps serving events.
    const message = await ok<ChatMessage>(socket, "chat:message", { roomCode: code, senderId: "host", content: "after" });
    assert.equal(message.content, "after");
  });
});
