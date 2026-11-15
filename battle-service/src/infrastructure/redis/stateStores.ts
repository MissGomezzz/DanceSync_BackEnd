import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import type { Server } from "socket.io";
import type { MatchOutbox } from "../../domain/ports/MatchOutbox.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import type { WordRaceRepository } from "../../domain/ports/WordRaceRepository.js";
import { InMemoryBlockList, type BlockList } from "../abuse/blockList.js";
import { InMemoryMatchOutbox } from "../persistence/InMemoryMatchOutbox.js";
import { InMemoryRoomRepository } from "../persistence/InMemoryRoomRepository.js";
import { InMemoryWordRaceRepository } from "../persistence/InMemoryWordRaceRepository.js";
import { RedisBlockList } from "./RedisBlockList.js";
import { RedisMatchOutbox } from "./RedisMatchOutbox.js";
import { RedisRoomRepository } from "./RedisRoomRepository.js";
import { RedisWordRaceRepository } from "./RedisWordRaceRepository.js";
import { describeRedisUrl, loadRedisConfig, type RedisConfig } from "./redisConfig.js";

/**
 * Where the room and word race state lives, plus what a multi-instance
 * deployment needs besides it: the Socket.IO adapter that carries broadcasts
 * between instances. With no REDIS_URL everything stays in memory and
 * `attachAdapter` does nothing, exactly like the single-instance service.
 */
export interface StateStores {
  readonly mode: "memory" | "redis";
  readonly rooms: RoomRepository;
  readonly wordRaces: WordRaceRepository;
  /** Temporary blocks of abusive clients (SEG-3): shared between instances with Redis. */
  readonly blocks: BlockList;
  /** Finished matches not delivered to the match history yet (DIS-1): shared between instances with Redis. */
  readonly matchOutbox: MatchOutbox;
  /** Makes io.to(room).emit and io.in(room).fetchSockets() span every instance. */
  attachAdapter(io: Server<any, any, any, any>): void;
  /** Resolves when the store answers (readiness probe, DIS-1); rejects otherwise. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createStateStores(config: RedisConfig = loadRedisConfig()): StateStores {
  if (config.url === "") {
    console.log("State store: in memory (single instance). Set REDIS_URL to share it between instances.");
    return {
      mode: "memory",
      rooms: new InMemoryRoomRepository(),
      wordRaces: new InMemoryWordRaceRepository(),
      blocks: new InMemoryBlockList(),
      matchOutbox: new InMemoryMatchOutbox(),
      attachAdapter() {},
      async ping() {},
      async close() {},
    };
  }

  const redis = connect(config.url, "state");
  // The adapter needs its own publisher and subscriber connections.
  const pub = redis.duplicate();
  const sub = redis.duplicate();
  for (const [name, client] of [["pub", pub], ["sub", sub]] as const) client.on("error", logRedisError(name));
  console.log(`State store: Redis at ${describeRedisUrl(config.url)} (Socket.IO adapter key "${config.adapterKey}")`);

  return {
    mode: "redis",
    rooms: new RedisRoomRepository(redis, { ttlSeconds: config.ttlSeconds, maxAttempts: config.maxUpdateAttempts }),
    wordRaces: new RedisWordRaceRepository(redis, { ttlSeconds: config.ttlSeconds }),
    blocks: new RedisBlockList(redis),
    // A delivered match is remembered at least as long as a finished room can live (its TTL), twice to be safe.
    matchOutbox: new RedisMatchOutbox(redis, { deliveredRetentionSeconds: config.ttlSeconds * 2 }),
    attachAdapter(io) {
      // requestsTimeout bounds fetchSockets and friends when a replica stops
      // answering (DIS-1): the request fails fast instead of holding a join.
      io.adapter(createAdapter(pub, sub, { key: config.adapterKey, requestsTimeout: config.adapterRequestsTimeoutMs }));
    },
    async ping() {
      const reply = await redis.ping();
      if (reply !== "PONG") throw new Error(`unexpected PING reply from Redis: ${reply}`);
    },
    async close() {
      await Promise.allSettled([redis.quit(), pub.quit(), sub.quit()]);
    },
  };
}

function connect(url: string, name: string): Redis {
  const client = new Redis(url);
  client.on("error", logRedisError(name));
  return client;
}

function logRedisError(name: string) {
  return (error: Error) => console.error(`Redis connection "${name}" error: ${error.message}`);
}
