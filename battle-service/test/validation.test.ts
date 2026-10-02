import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainError } from "../src/domain/errors/DomainError.js";
import { RoomService, requireRoomCode, validatePlayer } from "../src/domain/services/RoomService.js";

function assertDomainError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code);
}

describe("Client input validation in the domain", () => {
  it("accepts a valid identity and trims the display name", () => {
    assert.deepEqual(validatePlayer("p1", "  Ana  "), { id: "p1", displayName: "Ana" });
    assert.deepEqual(validatePlayer("x".repeat(64), "y".repeat(32)), { id: "x".repeat(64), displayName: "y".repeat(32) });
  });

  it("rejects missing, blank, padded, oversized or non-text player ids with INVALID_PLAYER", () => {
    for (const id of [undefined, null, 7, "", "   ", " p1", "p1 ", "x".repeat(65), ["p1"]]) {
      assertDomainError(() => validatePlayer(id, "Ana"), "INVALID_PLAYER");
    }
  });

  it("rejects blank, oversized or non-text display names with INVALID_PLAYER", () => {
    for (const name of [undefined, null, 42, "", "   ", "y".repeat(33), { name: "Ana" }]) {
      assertDomainError(() => validatePlayer("p1", name), "INVALID_PLAYER");
    }
  });

  it("rooms enforce the same rule for the host and for anyone joining", () => {
    assertDomainError(() => RoomService.create({ id: "", displayName: "Host" }), "INVALID_PLAYER");
    const room = RoomService.create({ id: "host", displayName: " Host " }, "ROOM01");
    assert.equal(room.players[0].displayName, "Host");
    assertDomainError(() => RoomService.join(room, { id: "guest", displayName: "z".repeat(40) }), "INVALID_PLAYER");
  });

  it("a room code must be non-empty text", () => {
    assert.equal(requireRoomCode(" abc123 "), "abc123");
    for (const code of [undefined, 123, "", "  ", { code: "A" }]) assertDomainError(() => requireRoomCode(code), "ROOM_NOT_FOUND");
  });

  it("role must be dancer or spectator", () => {
    const room = RoomService.create({ id: "host", displayName: "Host" }, "ROOM01");
    for (const role of ["admin", "undecided", 1, null]) {
      assertDomainError(() => RoomService.selectRole(room, "host", role as "dancer"), "INVALID_MESSAGE");
    }
  });

  it("explicit dancerIds must be a list of ids", () => {
    let room = RoomService.create({ id: "host", displayName: "Host" }, "ROOM01");
    room = RoomService.join(room, { id: "guest", displayName: "Guest" });
    for (const dancerIds of ["host,guest", [1, 2], ["host", 2], { 0: "host", 1: "guest" }]) {
      assertDomainError(() => RoomService.startBattle(room, dancerIds as string[]), "INVALID_DANCER");
    }
    assert.equal(RoomService.startBattle(room, ["host", "guest"]).status, "battling");
  });
});
