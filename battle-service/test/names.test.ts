import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JoinRoom } from "../src/application/usecases/JoinRoom.js";
import { MAX_DISPLAY_NAME_LENGTH } from "../src/domain/model/Player.js";
import { RoomService, uniqueDisplayName } from "../src/domain/services/RoomService.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";

describe("Display names are unique within a room (HU 19)", () => {
  it("suffixes a name already used in the room with 2, 3, ...", () => {
    let room = RoomService.create({ id: "h", displayName: "Ana" }, "ROOM01");
    room = RoomService.join(room, { id: "p2", displayName: "Ana" });
    room = RoomService.join(room, { id: "p3", displayName: "  Ana " });
    room = RoomService.join(room, { id: "p4", displayName: "Beto" });
    assert.deepEqual(room.players.map((p) => p.displayName), ["Ana", "Ana 2", "Ana 3", "Beto"]);
  });

  it("compares names ignoring case and skips suffixes already taken", () => {
    const players = [{ displayName: "ana" }, { displayName: "Ana 2" }];
    assert.equal(uniqueDisplayName(players, "ANA"), "ANA 3");
    assert.equal(uniqueDisplayName(players, "Ana 2"), "Ana 2 2");
    assert.equal(uniqueDisplayName(players, "Caro"), "Caro");
  });

  it("keeps a suffixed name within the length limit", () => {
    const long = "x".repeat(MAX_DISPLAY_NAME_LENGTH);
    const name = uniqueDisplayName([{ displayName: long }], long);
    assert.equal(name.length, MAX_DISPLAY_NAME_LENGTH);
    assert.ok(name.endsWith(" 2"));
  });

  it("a player rejoining after a refresh keeps their own name instead of getting a suffix", async () => {
    const rooms = new InMemoryRoomRepository();
    await rooms.insert(RoomService.create({ id: "h", displayName: "Ana" }, "ROOM01"));
    const joinRoom = new JoinRoom(rooms);
    await joinRoom.execute({ roomCode: "ROOM01", playerId: "p2", displayName: "Ana" });
    const again = await joinRoom.execute({ roomCode: "ROOM01", playerId: "p2", displayName: "Ana" });
    const hostAgain = await joinRoom.execute({ roomCode: "ROOM01", playerId: "h", displayName: "Ana" });
    assert.deepEqual(again.players.map((p) => p.displayName), ["Ana", "Ana 2"]);
    assert.deepEqual(hostAgain.players.map((p) => p.displayName), ["Ana", "Ana 2"]);
  });
});
