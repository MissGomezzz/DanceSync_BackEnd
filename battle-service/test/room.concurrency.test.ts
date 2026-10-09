import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { RateDancer } from "../src/application/usecases/RateDancer.js";
import { SubmitSongPhrase } from "../src/application/usecases/SubmitSongPhrase.js";
import { DomainError } from "../src/domain/errors/DomainError.js";
import type { Player } from "../src/domain/model/Player.js";
import type { Room } from "../src/domain/model/Room.js";
import type { RoomMutation, RoomRepository } from "../src/domain/ports/RoomRepository.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { SongSelectionService } from "../src/domain/services/SongSelectionService.js";
import { InMemoryRoomRepository } from "../src/infrastructure/persistence/InMemoryRoomRepository.js";
import { SONG_CATALOG } from "../src/domain/catalog/songs.js";

/**
 * Concurrency proofs for the Room aggregate (optimistic versioning).
 *
 * The in-memory store answers synchronously, which hides races. Two slow views
 * of a store are used instead, each waiting a random 0-5 ms per call like a
 * network round trip, so concurrent commands genuinely interleave:
 * - LatencyRoomRepository: the real in-memory adapter behind a delay.
 * - RemoteRoomStore: a stand-in for SQL/Redis implementing `update` exactly as
 *   RoomRepository documents it (read, mutate, compare-and-set on the version,
 *   retry on conflict), plus the blind `save` the port deliberately does not
 *   offer, used only by the negative controls.
 */
async function roundTrip(): Promise<void> {
  await sleep(Math.random() * 5);
}

class LatencyRoomRepository implements RoomRepository {
  constructor(private readonly inner: RoomRepository) {}

  async findByCode(code: string): Promise<Room | undefined> {
    await roundTrip();
    return this.inner.findByCode(code);
  }

  async listCodes(): Promise<string[]> {
    await roundTrip();
    return this.inner.listCodes();
  }

  async insert(room: Room): Promise<boolean> {
    await roundTrip();
    return this.inner.insert(room);
  }

  async update(code: string, mutate: RoomMutation): Promise<Room | null> {
    await roundTrip();
    return this.inner.update(code, mutate);
  }
}

class RemoteRoomStore implements RoomRepository {
  private readonly rows = new Map<string, Room>();
  /** Compare-and-set attempts that lost against another writer and were retried. */
  conflicts = 0;

  /**
   * A bound of at least the number of concurrent writers guarantees progress
   * (each conflict means another writer succeeded). Production adapters use a
   * small bound plus a jittered backoff instead.
   */
  constructor(private readonly maxAttempts: number) {}

  async findByCode(code: string): Promise<Room | undefined> {
    await roundTrip();
    const row = this.rows.get(code);
    return row ? structuredClone(row) : undefined;
  }

  async listCodes(): Promise<string[]> {
    await roundTrip();
    return [...this.rows.keys()];
  }

  async insert(room: Room): Promise<boolean> {
    await roundTrip();
    if (this.rows.has(room.code)) return false;
    this.rows.set(room.code, structuredClone(room));
    return true;
  }

  async update(code: string, mutate: RoomMutation): Promise<Room | null> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const current = await this.findByCode(code);
      if (!current) throw new DomainError("ROOM_NOT_FOUND", `Room ${code} does not exist`);
      const next = mutate(current);
      if (next === current) return current;
      if (await this.compareAndSet(code, current.version, next)) {
        return next === null ? null : { ...next, version: current.version + 1 };
      }
      this.conflicts++;
    }
    throw new Error(`Gave up updating room ${code} after ${this.maxAttempts} conflicting attempts`);
  }

  /** `UPDATE rooms SET data = $1, version = version + 1 WHERE code = $2 AND version = $3`. */
  private async compareAndSet(code: string, expectedVersion: number, next: Room | null): Promise<boolean> {
    await roundTrip();
    // Single synchronous block, like the single SQL statement.
    if (this.rows.get(code)?.version !== expectedVersion) return false;
    if (next === null) this.rows.delete(code);
    else this.rows.set(code, structuredClone({ ...next, version: expectedVersion + 1 }));
    return true;
  }

  /** DELIBERATELY BROKEN blind write (no version check). Negative controls only. */
  async blindSave(room: Room): Promise<void> {
    await roundTrip();
    this.rows.set(room.code, structuredClone(room));
  }
}

const CODE = "ROOM01";
const PHRASE = "dale play";
const ITERATIONS = 10;

function player(id: string, role: Player["role"]): Player {
  return { id, displayName: id, role, ready: true };
}

/**
 * Room built field by field: these tests need far more players than a real
 * room admits (MAX_PLAYERS), to make the races as likely as possible.
 */
function crowdedRoom(dancers: string[], spectators: string[]): Room {
  const room = RoomService.create({ id: dancers[0], displayName: dancers[0] }, CODE);
  return {
    ...room,
    selectedSong: SONG_CATALOG[0],
    players: [...dancers.map((id) => player(id, "dancer")), ...spectators.map((id) => player(id, "spectator"))],
  };
}

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
}

/** Every (spectator, dancer) pair, i.e. every rating needed to finish the battle. */
function allRatings(spectators: string[], dancers: string[]): { raterId: string; dancerId: string; score: number }[] {
  return spectators.flatMap((raterId, i) => dancers.map((dancerId, j) => ({ raterId, dancerId, score: ((i + j) % 5) + 1 })));
}

async function seed<T extends RoomRepository>(repository: T, room: Room): Promise<T> {
  assert.equal(await repository.insert(room), true);
  return repository;
}

describe("Room concurrency: simultaneous ratings are never lost", () => {
  const dancers = ids("dancer", 2);
  const spectators = ids("fan", 50);
  const ratings = allRatings(spectators, dancers);

  async function rateAll(repository: RoomRepository): Promise<{ finished: number; stored: Room }> {
    const rateDancer = new RateDancer(repository);
    const results = await Promise.all(ratings.map((r) => rateDancer.execute({ roomCode: CODE, ...r })));
    const stored = (await repository.findByCode(CODE))!;
    return { finished: results.filter((r) => r.finished).length, stored };
  }

  it(`${ratings.length} simultaneous ratings are all stored and finish the battle once (${ITERATIONS} iterations)`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const battle = RoomService.startBattle(crowdedRoom(dancers, spectators));
      const repository = await seed(new LatencyRoomRepository(new InMemoryRoomRepository()), battle);
      const { finished, stored } = await rateAll(repository);
      assert.equal(stored.battle!.ratings.length, ratings.length, `iteration ${iteration}: ratings lost`);
      assert.equal(stored.status, "finished");
      assert.equal(finished, 1, `iteration ${iteration}: ${finished} ratings reported finishing the battle`);
      assert.equal(stored.version, ratings.length, "one version per stored change");
    }
  });

  it("the same holds on a store with real version conflicts (compare-and-set and retry)", async () => {
    const few = ids("fan", 10);
    const wanted = allRatings(few, dancers);
    const repository = await seed(new RemoteRoomStore(wanted.length + 5), RoomService.startBattle(crowdedRoom(dancers, few)));
    const rateDancer = new RateDancer(repository);
    const results = await Promise.all(wanted.map((r) => rateDancer.execute({ roomCode: CODE, ...r })));
    const stored = (await repository.findByCode(CODE))!;
    console.log(`remote store: ${wanted.length} concurrent ratings, ${repository.conflicts} version conflicts retried`);
    assert.ok(repository.conflicts > 0, "no conflict happened, the test proves nothing");
    assert.equal(stored.battle!.ratings.length, wanted.length);
    assert.equal(stored.status, "finished");
    assert.equal(results.filter((r) => r.finished).length, 1);
  });

  it("negative control: read -> rate -> blind save DOES lose ratings", async () => {
    const repository = await seed(new RemoteRoomStore(1), RoomService.startBattle(crowdedRoom(dancers, spectators)));
    await Promise.all(
      ratings.map(async (r) => {
        const room = (await repository.findByCode(CODE))!;
        await repository.blindSave(RoomService.rate(room, r));
      }),
    );
    const stored = (await repository.findByCode(CODE))!;
    console.log(`naive read-then-save: ${stored.battle!.ratings.length}/${ratings.length} ratings survived`);
    assert.ok(stored.battle!.ratings.length < ratings.length, "the naive version lost nothing");
  });
});

describe("Room concurrency: only one dancer wins the song challenge", () => {
  const dancers = ids("dancer", 100);

  function typingRoom(): Room {
    return SongSelectionService.start(crowdedRoom(dancers, []), { phrases: [PHRASE], durationMs: 60_000 });
  }

  async function submitAll(repository: RoomRepository) {
    const submit = new SubmitSongPhrase(repository);
    return Promise.all(
      dancers.map((playerId) =>
        submit.execute({ roomCode: CODE, playerId, text: PHRASE }).then(
          (result) => ({ playerId, outcome: result.outcome as string }),
          (error: unknown) => ({ playerId, outcome: error instanceof DomainError ? error.code : String(error) }),
        ),
      ),
    );
  }

  function assertSingleChooser(results: { playerId: string; outcome: string }[], stored: Room, label: string): void {
    const winners = results.filter((r) => r.outcome === "accepted");
    assert.equal(winners.length, 1, `${label}: ${winners.length} dancers were told they won`);
    assert.ok(
      results.every((r) => r.outcome === "accepted" || r.outcome === "SONG_SELECTION_NOT_ACTIVE"),
      `${label}: unexpected outcome`,
    );
    assert.equal(stored.songSelection!.phase, "choosing");
    assert.equal(stored.songSelection!.chooserId, winners[0].playerId, `${label}: stored chooser is not the winner`);
  }

  it(`${dancers.length} simultaneous correct phrases produce exactly one chooser (${ITERATIONS} iterations)`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const repository = await seed(new LatencyRoomRepository(new InMemoryRoomRepository()), typingRoom());
      const results = await submitAll(repository);
      assertSingleChooser(results, (await repository.findByCode(CODE))!, `iteration ${iteration}`);
    }
  });

  it("the same holds on a store with real version conflicts", async () => {
    const repository = await seed(new RemoteRoomStore(dancers.length + 5), typingRoom());
    const results = await submitAll(repository);
    assertSingleChooser(results, (await repository.findByCode(CODE))!, "remote store");
  });

  it("negative control: read -> submit -> blind save DOES crown several dancers", async () => {
    let iterationsWithSeveralWinners = 0;
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const repository = await seed(new RemoteRoomStore(1), typingRoom());
      const outcomes = await Promise.all(
        dancers.map(async (playerId) => {
          const room = (await repository.findByCode(CODE))!;
          try {
            const result = SongSelectionService.submit(room, playerId, PHRASE);
            await repository.blindSave(result.room);
            return result.outcome;
          } catch {
            return "rejected";
          }
        }),
      );
      if (outcomes.filter((o) => o === "accepted").length > 1) iterationsWithSeveralWinners++;
    }
    console.log(`naive read-then-save: ${iterationsWithSeveralWinners}/${ITERATIONS} iterations crowned several dancers`);
    assert.ok(iterationsWithSeveralWinners > 0, "the naive version never crowned several dancers");
  });
});

describe("InMemoryRoomRepository.update", () => {
  it("refuses a write based on an older version (the read -> save misuse)", async () => {
    const repository = new InMemoryRoomRepository();
    await repository.insert(RoomService.create({ id: "host", displayName: "Host" }, CODE));
    const stale = (await repository.findByCode(CODE))!;
    await repository.update(CODE, (room) => RoomService.join(room, { id: "guest", displayName: "Guest" }));
    await assert.rejects(repository.update(CODE, () => RoomService.join(stale, { id: "other", displayName: "Other" })), /Stale write/);
    assert.deepEqual((await repository.findByCode(CODE))!.players.map((p) => p.id), ["host", "guest"]);
  });

  it("writes nothing when the mutation throws or returns the room unchanged", async () => {
    const repository = new InMemoryRoomRepository();
    await repository.insert(RoomService.create({ id: "host", displayName: "Host" }, CODE));
    await assert.rejects(
      repository.update(CODE, (room) => RoomService.selectRole(room, "nobody", "dancer")),
      (error: unknown) => error instanceof DomainError && error.code === "PLAYER_NOT_IN_ROOM",
    );
    await repository.update(CODE, (room) => room);
    assert.equal((await repository.findByCode(CODE))!.version, 0);
  });

  it("deletes the room when the mutation returns null, and reports ROOM_NOT_FOUND afterwards", async () => {
    const repository = new InMemoryRoomRepository();
    await repository.insert(RoomService.create({ id: "host", displayName: "Host" }, CODE));
    assert.equal(await repository.update(CODE, () => null), null);
    assert.equal(await repository.findByCode(CODE), undefined);
    await assert.rejects(
      repository.update(CODE, (room) => room),
      (error: unknown) => error instanceof DomainError && error.code === "ROOM_NOT_FOUND",
    );
  });
});
