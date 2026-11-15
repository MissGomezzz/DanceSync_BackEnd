import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import express from "express";
import type { Socket as ClientSocket } from "socket.io-client";
import { CreateRoom } from "../src/application/usecases/CreateRoom.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { MatchRecordService } from "../src/domain/services/MatchRecordService.js";
import { WordRaceService } from "../src/domain/services/WordRaceService.js";
import { createAccessLog } from "../src/infrastructure/http/accessLog.js";
import { buildRouter } from "../src/infrastructure/http/routes.js";
import { HttpMatchResultPublisher } from "../src/infrastructure/http/HttpMatchResultPublisher.js";
import { createLogger, logLevelFrom } from "../src/infrastructure/logging/logger.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";
import { toRoomDto } from "../src/infrastructure/serialization/roomDto.js";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { battleRoom, T0 } from "./support/battles.js";
import { stubTokenVerifier } from "./support/auth.js";
import { RecordingLogger } from "./support/logs.js";
import { pickSong, readyUp } from "./support/ready.js";
import { ok, SocketHarness } from "./support/socketHarness.js";

const TRACE = "trace-obs1-0001";

describe("OBS-1: JSON log lines", () => {
  it("writes one JSON object per line with service, instance, level, ISO timestamp and message", () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger = createLogger({ level: "info", destination });
    logger.info({ correlationId: TRACE, event: "battle:start" }, "Socket event handled");
    logger.debug({}, "not written at info");

    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(line.service, "battle-service");
    assert.equal(line.level, "info");
    assert.equal(line.message, "Socket event handled");
    assert.equal(line.correlationId, TRACE);
    assert.equal(typeof line.instance, "string");
    assert.equal(new Date(line.timestamp as string).toISOString(), line.timestamp);
  });

  it("reads LOG_LEVEL, and stays silent inside the test runner unless asked", () => {
    assert.equal(logLevelFrom({ LOG_LEVEL: "DEBUG" }), "debug");
    assert.equal(logLevelFrom({}), "info");
    assert.equal(logLevelFrom({ NODE_TEST_CONTEXT: "child" }), "silent");
    assert.equal(logLevelFrom({ LOG_LEVEL: "nonsense" }), "info");
  });
});

describe("OBS-1: the battle is the traced unit", () => {
  it("keeps the start request's correlation id in the battle, the word race and the match, never in the DTO", () => {
    const room = battleRoom(["a", "b"], ["fan"], { correlationId: TRACE });
    assert.equal(room.battle!.correlationId, TRACE);
    assert.equal(WordRaceService.plan(room).correlationId, TRACE);

    const finished = RoomService.finishBattle(room, "song-end", new Date(T0.getTime() + 60_000));
    assert.equal(MatchRecordService.fromFinishedRoom(finished)!.correlationId, TRACE);
    assert.equal("correlationId" in toRoomDto(finished, new Date()).battle!, false, "clients never see it");
  });

  it("leaves battles without a correlation id as they were (rooms stored before OBS-1)", () => {
    const room = battleRoom(["a", "b"], []);
    assert.equal("correlationId" in room.battle!, false);
    const finished = RoomService.finishBattle(room, "song-end", new Date(T0.getTime() + 60_000));
    assert.equal("correlationId" in MatchRecordService.fromFinishedRoom(finished)!, false);
  });
});

describe("OBS-1: the match reaches users-service with the battle's correlation id", () => {
  function capturingFetch() {
    const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { requests, fetchImpl };
  }

  function finishedMatch(correlationId?: string) {
    const room = battleRoom(["a", "b"], [], correlationId ? { correlationId } : {});
    return MatchRecordService.fromFinishedRoom(RoomService.finishBattle(room, "song-end", new Date(T0.getTime() + 60_000)))!;
  }

  it("sends X-Correlation-Id and keeps it out of the stored document", async () => {
    const { requests, fetchImpl } = capturingFetch();
    await new HttpMatchResultPublisher("http://users:8081", 1_000, fetchImpl).publish(finishedMatch(TRACE));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers["x-correlation-id"], TRACE);
    assert.equal("correlationId" in requests[0].body, false);
  });

  it("generates one only when the battle has none", async () => {
    const { requests, fetchImpl } = capturingFetch();
    await new HttpMatchResultPublisher("http://users:8081", 1_000, fetchImpl).publish(finishedMatch());
    assert.match(requests[0].headers["x-correlation-id"], /^[A-Za-z0-9._-]{1,64}$/);
  });
});

describe("OBS-1: Socket.IO events are logged with the handshake's correlation id", () => {
  it("stores the battle:start correlation id in the battle and logs every handled event with it", async () => {
    const logger = new RecordingLogger();
    const harness = new SocketHarness();
    await harness.start({ auth: { verifier: stubTokenVerifier }, extend: () => ({ logger }) });
    try {
      const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
      const sockets: Record<string, ClientSocket> = {};
      for (const id of ["host", "d2"]) {
        sockets[id] = await harness.client(`user:${id}`, { "X-Correlation-Id": `${TRACE}-${id}` });
        await ok(sockets[id], "room:join", { roomCode: code, displayName: id });
        await ok(sockets[id], "role:select", { roomCode: code, playerId: id, role: "dancer" });
      }
      await readyUp(code, sockets);
      await pickSong(harness.rooms, code);
      await ok<RoomDto>(sockets.host, "battle:start", { roomCode: code, requesterId: "host" });

      assert.equal((await harness.storedRoom(code)).battle!.correlationId, `${TRACE}-host`);
      const start = logger.find("Socket event handled").find((line) => line.fields.event === "battle:start");
      assert.ok(start, "battle:start is logged");
      assert.equal(start.fields.correlationId, `${TRACE}-host`);
      assert.equal(start.fields.roomId, code);
      assert.equal(start.fields.ok, true);
      assert.equal(typeof start.fields.durationMs, "number");
      const started = logger.find("Battle started")[0];
      assert.equal(started.fields.correlationId, `${TRACE}-host`);
      const joins = logger.find("Socket event handled").filter((line) => line.fields.event === "room:join");
      assert.deepEqual(new Set(joins.map((line) => line.fields.correlationId)), new Set([`${TRACE}-host`, `${TRACE}-d2`]));
    } finally {
      await harness.stop();
    }
  });
});

describe("OBS-1: one access log line per HTTP request", () => {
  it("logs the correlation id, method, route template, status and duration, never the query string", async () => {
    const logger = new RecordingLogger();
    const observed: Array<{ route: string; status: number; method: string }> = [];
    const rooms = new InMemoryRoomRepository();
    const app = express();
    app.use(createAccessLog({ logger, observe: (request) => observed.push(request) }));
    app.use(express.json());
    app.use(buildRouter({ auth: { verifier: stubTokenVerifier }, createRoom: new CreateRoom(rooms), rooms, logger }));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://localhost:${port}/api/rooms/NOPE01?secret=x`, {
        headers: { authorization: "Bearer user:ana", "x-correlation-id": TRACE },
      });
      assert.equal(response.status, 404);
      await fetch(`http://localhost:${port}/nowhere`);

      const [line, unmatched] = logger.find("HTTP request");
      assert.deepEqual(
        { ...line.fields, durationMs: typeof line.fields.durationMs },
        {
          correlationId: TRACE,
          method: "GET",
          route: "/api/rooms/:code",
          path: "/api/rooms/NOPE01",
          status: 404,
          durationMs: "number",
        },
      );
      assert.equal(unmatched.fields.route, "unmatched", "unknown paths share one bounded label");
      assert.deepEqual(
        observed.map(({ route, status, method }) => ({ route, status, method })),
        [
          { route: "/api/rooms/:code", status: 404, method: "GET" },
          { route: "unmatched", status: 404, method: "GET" },
        ],
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
