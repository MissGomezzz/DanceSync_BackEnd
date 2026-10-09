import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Socket as ClientSocket } from "socket.io-client";
import { RecordMatchResult } from "../src/application/usecases/RecordMatchResult.js";
import type { MatchRecord } from "../src/domain/model/MatchRecord.js";
import type { Room } from "../src/domain/model/Room.js";
import { MatchPublishError, type MatchResultPublisher } from "../src/domain/ports/MatchResultPublisher.js";
import { MatchRecordService } from "../src/domain/services/MatchRecordService.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { HttpMatchResultPublisher } from "../src/infrastructure/http/HttpMatchResultPublisher.js";
import type { RoomDto } from "../src/infrastructure/serialization/roomDto.js";
import { at, battleRoom } from "./support/battles.js";
import { pickSong, readyUp } from "./support/ready.js";
import { ok, record, SocketHarness, waitUntil } from "./support/socketHarness.js";

/** a, b, c dance and s1, s2 watch; c and s2 leave early; s1 votes for b; a wins a word. */
function finishedRoom(): Room {
  let room = battleRoom(["a", "b", "c"], ["s1", "s2"]);
  room = RoomService.castVote(room, "s1", "b", at(1_000));
  room = RoomService.awardWordBonus(room, "a");
  room = RoomService.awardWordBonus(room, "c");
  room = RoomService.leave(room, "c", at(2_000));
  room = RoomService.leave(room, "s2", at(3_000));
  return RoomService.finishAtDeadline(room, room.battle!.endsAt);
}

/** Port double: fails the first `failures` calls (with `error`), then succeeds. */
class FakePublisher implements MatchResultPublisher {
  readonly calls: MatchRecord[] = [];
  constructor(
    private failures = 0,
    private readonly error: Error = new MatchPublishError("users-service answered 503", true),
  ) {}

  async publish(match: MatchRecord): Promise<void> {
    this.calls.push(match);
    if (this.failures > 0) {
      this.failures--;
      throw this.error;
    }
  }
}

function quietRecorder(publisher: MatchResultPublisher, delays: number[], errors: unknown[] = []) {
  return new RecordMatchResult(publisher, {
    baseDelayMs: 100,
    sleep: async (ms) => {
      delays.push(ms);
    },
    logger: { info: () => undefined, error: (...args: unknown[]) => errors.push(args) },
  });
}

describe("MatchRecordService: the match history document of a finished battle (HU 21)", () => {
  it("lists every dancer with final stats and every spectator, flagging who left early; id = battle id", () => {
    const room = finishedRoom();
    const match = MatchRecordService.fromFinishedRoom(room)!;
    assert.equal(match.id, room.battle!.id);
    assert.equal(match.roomCode, "ROOM01");
    assert.equal(match.songId, room.battle!.song!.id);
    assert.equal(match.songTitle, room.battle!.song!.title);
    assert.equal(match.startedAt.getTime(), room.battle!.startedAt.getTime());
    assert.equal(match.finishedAt.getTime(), room.battle!.finishedAt!.getTime());
    assert.equal(match.endReason, "song-end");
    assert.equal(match.winnerPlayerId, "b");
    assert.deepEqual(match.participants, [
      { playerId: "a", displayName: "A", role: "dancer", votes: 0, wordsWon: 1, score: 1, rank: 2, leftEarly: false },
      { playerId: "b", displayName: "B", role: "dancer", votes: 1, wordsWon: 0, score: 2, rank: 1, leftEarly: false },
      { playerId: "c", displayName: "C", role: "dancer", votes: null, wordsWon: 1, score: null, rank: null, leftEarly: true },
      { playerId: "s1", displayName: "S1", role: "spectator", votes: null, wordsWon: null, score: null, rank: null, leftEarly: false },
      { playerId: "s2", displayName: "S2", role: "spectator", votes: null, wordsWon: null, score: null, rank: null, leftEarly: true },
    ]);
  });

  it("is null for a room without a finished battle", () => {
    assert.equal(MatchRecordService.fromFinishedRoom(battleRoom(["a", "b"], [])), null);
    assert.equal(MatchRecordService.fromFinishedRoom(RoomService.rematch(finishedRoom(), "a")), null);
  });
});

describe("RecordMatchResult: retries with exponential backoff, never throws", () => {
  it("stores the match on the first try", async () => {
    const publisher = new FakePublisher();
    const delays: number[] = [];
    assert.equal(await quietRecorder(publisher, delays).execute(finishedRoom()), true);
    assert.equal(publisher.calls.length, 1);
    assert.deepEqual(delays, []);
  });

  it("retries a failed publish with the same idempotent id (the battle id), doubling the wait", async () => {
    const room = finishedRoom();
    const publisher = new FakePublisher(2);
    const delays: number[] = [];
    assert.equal(await quietRecorder(publisher, delays).execute(room), true);
    assert.equal(publisher.calls.length, 3);
    assert.ok(publisher.calls.every((m) => m.id === room.battle!.id), "every try must reuse the battle id");
    assert.deepEqual(delays, [100, 200]);
  });

  it("gives up after 3 attempts, logs the failure and resolves to false instead of throwing", async () => {
    const publisher = new FakePublisher(10, new Error("connection refused"));
    const delays: number[] = [];
    const errors: unknown[] = [];
    assert.equal(await quietRecorder(publisher, delays, errors).execute(finishedRoom()), false);
    assert.equal(publisher.calls.length, 3);
    assert.deepEqual(delays, [100, 200]);
    assert.equal(errors.length, 1);
  });

  it("does not retry a document the store refused (non-retryable error)", async () => {
    const publisher = new FakePublisher(10, new MatchPublishError("users-service answered 400", false));
    const delays: number[] = [];
    assert.equal(await quietRecorder(publisher, delays).execute(finishedRoom()), false);
    assert.equal(publisher.calls.length, 1);
    assert.deepEqual(delays, []);
  });

  it("publishes nothing for a room without a finished battle", async () => {
    const publisher = new FakePublisher();
    assert.equal(await quietRecorder(publisher, []).execute(battleRoom(["a", "b"], [])), false);
    assert.equal(publisher.calls.length, 0);
  });
});

describe("HttpMatchResultPublisher: PUT /api/matches/{battleId} on users-service", () => {
  let server: Server;
  let baseUrl: string;
  let nextStatus = 200;
  const received: { method?: string; url?: string; type?: string; body: unknown }[] = [];

  before(async () => {
    server = createServer(async (req: IncomingMessage, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      received.push({ method: req.method, url: req.url, type: req.headers["content-type"], body: JSON.parse(raw) });
      res.statusCode = nextStatus;
      res.end(nextStatus === 200 ? "{}" : '{"error":"nope"}');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}/`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("sends the match as JSON with ISO dates to the battle id's URL", async () => {
    nextStatus = 200;
    const match = MatchRecordService.fromFinishedRoom(finishedRoom())!;
    await new HttpMatchResultPublisher(baseUrl).publish(match);
    const last = received.at(-1)!;
    assert.equal(last.method, "PUT");
    assert.equal(last.url, `/api/matches/${match.id}`);
    assert.equal(last.type, "application/json");
    const body = last.body as Record<string, unknown>;
    assert.equal(body.startedAt, match.startedAt.toISOString());
    assert.equal(body.endReason, "song-end");
    assert.equal((body.participants as unknown[]).length, 5);
  });

  it("maps a 5xx to a retryable error and a 4xx to a non-retryable one", async () => {
    const match = MatchRecordService.fromFinishedRoom(finishedRoom())!;
    const publisher = new HttpMatchResultPublisher(baseUrl);
    nextStatus = 503;
    await assert.rejects(publisher.publish(match), (e: unknown) => e instanceof MatchPublishError && e.retryable);
    nextStatus = 400;
    await assert.rejects(publisher.publish(match), (e: unknown) => e instanceof MatchPublishError && !e.retryable);
  });

  it("maps an unreachable users-service to a retryable error", async () => {
    const match = MatchRecordService.fromFinishedRoom(finishedRoom())!;
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await assert.rejects(
      new HttpMatchResultPublisher(`http://localhost:${port}`).publish(match),
      (e: unknown) => e instanceof MatchPublishError && e.retryable,
    );
  });
});

describe("Finishing a battle publishes the match without depending on it", () => {
  /** A publisher that always fails, and one that never answers. */
  const failing = new FakePublisher(Number.MAX_SAFE_INTEGER, new Error("users-service down"));
  const hanging: MatchResultPublisher & { calls: MatchRecord[] } = {
    calls: [],
    publish(match) {
      this.calls.push(match);
      return new Promise<void>(() => undefined);
    },
  };

  async function playUntilFinished(harness: SocketHarness) {
    const { code } = await harness.createRoom.execute({ hostId: "host", displayName: "Host" });
    const sockets: Record<string, ClientSocket> = {};
    for (const [id, role] of [
      ["host", "dancer"],
      ["d2", "dancer"],
      ["fan", "spectator"],
    ] as const) {
      sockets[id] = await harness.client();
      await ok(sockets[id], "room:join", { roomCode: code, playerId: id, displayName: id });
      await ok(sockets[id], "role:select", { roomCode: code, playerId: id, role });
    }
    await readyUp(code, sockets);
    await pickSong(harness.rooms, code);
    const finished = record<RoomDto>(sockets.fan, "battle:finished");
    const started = await ok<RoomDto>(sockets.host, "battle:start", { roomCode: code, requesterId: "host" });
    await ok(sockets.fan, "vote:cast", { roomCode: code, voterId: "fan", dancerId: "host" });
    const left = await ok<RoomDto>(sockets.d2, "room:leave", { roomCode: code, playerId: "d2" });
    return { code, sockets, finished, battleId: started.battle!.id, left };
  }

  for (const [label, publisher] of [
    ["failing", failing],
    ["never answering", hanging],
  ] as const) {
    it(`with a ${label} users-service the room still finishes and the result is broadcast once`, async () => {
      const harness = new SocketHarness();
      await harness.start({
        extend: () => ({
          recordMatchResult: new RecordMatchResult(publisher, {
            baseDelayMs: 1,
            logger: { info: () => undefined, error: () => undefined },
          }),
        }),
      });
      try {
        const { code, finished, battleId, left, sockets } = await playUntilFinished(harness);
        assert.equal(left.status, "finished");
        await waitUntil(() => finished.length === 1, "battle:finished");
        assert.equal(finished[0].battle!.result!.winnerId, "host");
        await waitUntil(() => publisher.calls.some((m) => m.id === battleId), "the match handed to the port");
        assert.ok(publisher.calls.filter((m) => m.id === battleId).every((m) => m.winnerPlayerId === "host"));
        // The room keeps working: the host can start a rematch right away.
        const rematch = await ok<RoomDto>(sockets.host, "room:rematch", { roomCode: code, requesterId: "host" });
        assert.equal(rematch.status, "waiting");
        assert.equal(finished.length, 1, "battle:finished announced more than once");
      } finally {
        await harness.stop();
      }
    });
  }
});
