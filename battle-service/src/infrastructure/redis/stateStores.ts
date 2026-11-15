import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import type { Server } from "socket.io";
import type { Logger } from "../../application/ports/Logger.js";
import { noopMetrics, type Metrics } from "../../application/ports/Metrics.js";
import type { SessionTracker } from "../../application/ports/SessionTracker.js";
import type { MatchOutbox } from "../../domain/ports/MatchOutbox.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import type { WordRaceRepository } from "../../domain/ports/WordRaceRepository.js";
import { InMemoryBlockList, type BlockList } from "../abuse/blockList.js";
import { InMemoryMatchOutbox } from "../persistence/InMemoryMatchOutbox.js";
import { InMemoryRoomRepository } from "../persistence/InMemoryRoomRepository.js";
import { InMemoryWordRaceRepository } from "../persistence/InMemoryWordRaceRepository.js";
import { InMemorySessionTracker } from "../persistence/InMemorySessionTracker.js";
import { RedisSessionTracker } from "./RedisSessionTracker.js";
import { rootLogger } from "../logging/logger.js";
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
  /** Signed-in sessions (OBS-1): shared between instances with Redis, so a user is counted once. */
  readonly sessions: SessionTracker;
  /** Makes io.to(room).emit and io.in(room).fetchSockets() span every instance. */
  attachAdapter(io: Server<any, any, any, any>): void;
  /** Resolves when the store answers (readiness probe, DIS-1); rejects otherwise. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface StateStoreOptions {
  /** Default: the process logger. */
  logger?: Logger;
  /** Room update conflicts and Redis connection errors (OBS-1). Default: none. */
  metrics?: Metrics;
}

export function createStateStores(config: RedisConfig = loadRedisConfig(), options: StateStoreOptions = {}): StateStores {
  const logger = options.logger ?? rootLogger;
  const metrics = options.metrics ?? noopMetrics;
  if (config.url === "") {
    logger.info({ stateStore: "memory" }, "State store: in memory (single instance). Set REDIS_URL to share it between instances.");
    return {
      mode: "memory",
      rooms: new InMemoryRoomRepository(),
      wordRaces: new InMemoryWordRaceRepository(),
      blocks: new InMemoryBlockList(),
      matchOutbox: new InMemoryMatchOutbox(),
      sessions: new InMemorySessionTracker(),
      attachAdapter() {},
      async ping() {},
      async close() {},
    };
  }

  const redis = connect(config.url, "state", logger, metrics);
  // The adapter needs its own publisher and subscriber connections.
  const pub = redis.duplicate();
  const sub = redis.duplicate();
  for (const [name, client] of [["pub", pub], ["sub", sub]] as const) client.on("error", logRedisError(name, logger, metrics));
  // describeRedisUrl never includes the password.
  logger.info({ stateStore: "redis", redis: describeRedisUrl(config.url), adapterKey: config.adapterKey }, "State store: Redis");

  return {
    mode: "redis",
    rooms: new RedisRoomRepository(redis, {
      ttlSeconds: config.ttlSeconds,
      maxAttempts: config.maxUpdateAttempts,
      onConflict: (result) => metrics.roomConflict(result),
    }),
    wordRaces: new RedisWordRaceRepository(redis, { ttlSeconds: config.ttlSeconds }),
    blocks: new RedisBlockList(redis),
    // A delivered match is remembered at least as long as a finished room can live (its TTL), twice to be safe.
    matchOutbox: new RedisMatchOutbox(redis, { deliveredRetentionSeconds: config.ttlSeconds * 2 }),
    sessions: new RedisSessionTracker(redis),
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

function connect(url: string, name: string, logger: Logger, metrics: Metrics): Redis {
  const client = new Redis(url);
  client.on("error", logRedisError(name, logger, metrics));
  return client;
}

function logRedisError(name: string, logger: Logger, metrics: Metrics) {
  // The message only: an ioredis error may carry the connection options.
  return (error: Error) => {
    metrics.error("redis");
    logger.error({ connection: name, reason: error.message }, "Redis connection error");
  };
}
