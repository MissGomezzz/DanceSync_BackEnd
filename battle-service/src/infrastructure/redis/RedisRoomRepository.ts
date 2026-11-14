import { setTimeout as sleep } from "node:timers/promises";
import type { Redis } from "ioredis";
import { DomainError } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomMutation, RoomRepository } from "../../domain/ports/RoomRepository.js";
import { defineScript, type ScriptRunner } from "./luaScripts.js";
import { decodeRoom, encodeRoom } from "./roomCodec.js";

/** A room is a hash `room:{CODE}` with the JSON in `data` and the optimistic-lock counter in `version`. */
const INSERT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'data', ARGV[1], 'version', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1`;

/** Writes only if the stored version is still the one the decision was based on. */
const WRITE = `
if redis.call('HGET', KEYS[1], 'version') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'data', ARGV[2], 'version', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1`;

const REMOVE = `
if redis.call('HGET', KEYS[1], 'version') ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1`;

export interface RedisRoomRepositoryOptions {
  ttlSeconds: number;
  maxAttempts: number;
}

/** Thrown when an update lost the race against other writers more times than allowed. */
export class RoomUpdateConflictError extends Error {
  constructor(code: string, attempts: number) {
    super(`Could not update room ${code}: it kept changing under ${attempts} attempts`);
    this.name = "RoomUpdateConflictError";
  }
}

/**
 * RoomRepository on Redis, for several battle-service instances.
 *
 * `update` is the optimistic concurrency the port describes: read the room and
 * its version, run the pure domain decision (`mutate`) on that state and write
 * only if the version is unchanged (a Lua compare-and-set); a lost race re-reads
 * and decides again, with a short jittered pause, a bounded number of times.
 * Lua replaces the WATCH/MULTI of the port's documentation because WATCH is
 * tied to a connection and this repository shares one; the guarantee is the same.
 */
export class RedisRoomRepository implements RoomRepository {
  /** Lost races retried so far; useful to watch contention (see OBS-1). */
  readonly stats = { conflictRetries: 0, conflictFailures: 0 };

  private readonly insertScript: ScriptRunner;
  private readonly writeScript: ScriptRunner;
  private readonly removeScript: ScriptRunner;

  constructor(
    private readonly redis: Redis,
    private readonly options: RedisRoomRepositoryOptions,
  ) {
    this.insertScript = defineScript(redis, "dsRoomInsert", INSERT);
    this.writeScript = defineScript(redis, "dsRoomWrite", WRITE);
    this.removeScript = defineScript(redis, "dsRoomRemove", REMOVE);
  }

  async findByCode(code: string): Promise<Room | undefined> {
    const data = await this.redis.hget(roomKey(code), "data");
    return data === null ? undefined : decodeRoom(data);
  }

  async listCodes(): Promise<string[]> {
    const codes = new Set<string>();
    for await (const keys of this.redis.scanStream({ match: "room:{*}", count: 200 })) {
      for (const key of keys as string[]) codes.add(key.slice("room:{".length, -1));
    }
    return [...codes];
  }

  async insert(room: Room): Promise<boolean> {
    const stored = await this.insertScript(roomKey(room.code), encodeRoom(room), String(room.version), this.options.ttlSeconds);
    return Number(stored) === 1;
  }

  async update(code: string, mutate: RoomMutation): Promise<Room | null> {
    const key = roomKey(code);
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      const [data, version] = await this.redis.hmget(key, "data", "version");
      if (data === null || version === null) throw new DomainError("ROOM_NOT_FOUND", `Room ${code} does not exist`);

      const current = decodeRoom(data);
      const next = mutate(current);
      if (next === current) return current; // No change, no write.
      if (next !== null && next.version !== current.version) {
        throw new Error(`Stale write to room ${code}: based on version ${next.version}, stored version is ${current.version}`);
      }

      if (next === null) {
        if (Number(await this.removeScript(key, version)) === 1) return null;
      } else {
        const stored: Room = { ...next, version: current.version + 1 };
        const written = await this.writeScript(key, version, encodeRoom(stored), String(stored.version), this.options.ttlSeconds);
        if (Number(written) === 1) return stored;
      }

      // Someone else wrote first: decide again on the new state.
      this.stats.conflictRetries += 1;
      await sleep(Math.random() * Math.min(40, 2 ** attempt));
    }
    this.stats.conflictFailures += 1;
    throw new RoomUpdateConflictError(code, this.options.maxAttempts);
  }
}

/** The braces make the code a Redis Cluster hash tag; codes are case-insensitive like the in-memory store. */
function roomKey(code: string): string {
  return `room:{${code.toUpperCase()}}`;
}
