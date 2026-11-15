import type { Redis } from "ioredis";
import type { MatchRecord } from "../../domain/model/MatchRecord.js";
import type { MatchOutbox, PendingMatch } from "../../domain/ports/MatchOutbox.js";
import { defineScript, type ScriptRunner } from "./luaScripts.js";
import { decodeWithDates, encodeWithDates } from "./roomCodec.js";

/** Adds the entry unless it is pending or delivered. */
const ENQUEUE = `
if redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
return redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2])`;

/** Removes the entry, records the delivery (Redis clock) and forgets old deliveries. */
const ACK = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], now, ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[2]))
return 1`;

/** Replaces the entry only while it is still pending: an ack from another replica wins. */
const RETRY = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1`;

export interface RedisMatchOutboxOptions {
  /** How long a delivered match is remembered (so the sweep does not enqueue it again). */
  deliveredRetentionSeconds: number;
  /** Hash tag of both keys. Default "matchoutbox"; tests use their own. */
  namespace?: string;
}

/**
 * MatchOutbox in Redis, shared by every battle-service replica (DIS-1). Two
 * keys sharing the `{matchoutbox}` hash tag (the namespace):
 *   {matchoutbox}:pending    hash  battleId -> JSON PendingMatch
 *   {matchoutbox}:delivered  zset  battleId scored by delivery time (epoch ms)
 * The delivered set lets enqueue ignore a match that was already delivered
 * (the sweep re-enqueues every finished room, in case its finisher died before
 * enqueuing); it is pruned to `deliveredRetentionSeconds` on every ack.
 */
export class RedisMatchOutbox implements MatchOutbox {
  private readonly enqueueScript: ScriptRunner;
  private readonly ackScript: ScriptRunner;
  private readonly retryScript: ScriptRunner;
  private readonly pendingKey: string;
  private readonly deliveredKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly options: RedisMatchOutboxOptions,
  ) {
    this.enqueueScript = defineScript(redis, "dsOutboxEnqueue", ENQUEUE, 2);
    this.ackScript = defineScript(redis, "dsOutboxAck", ACK, 2);
    this.retryScript = defineScript(redis, "dsOutboxRetry", RETRY, 1);
    const namespace = options.namespace ?? "matchoutbox";
    this.pendingKey = `{${namespace}}:pending`;
    this.deliveredKey = `{${namespace}}:delivered`;
  }

  async enqueue(match: MatchRecord, notBefore: Date): Promise<boolean> {
    const entry: PendingMatch = { match, attempts: 0, nextAttemptAt: notBefore };
    return Number(await this.enqueueScript(this.pendingKey, this.deliveredKey, match.id, encodeWithDates(entry))) === 1;
  }

  async listPending(now: Date, limit: number): Promise<PendingMatch[]> {
    // The outbox only holds matches not delivered yet: a handful, even during an outage.
    const entries = Object.values(await this.redis.hgetall(this.pendingKey)).map((raw) => decodeWithDates<PendingMatch>(raw));
    return entries
      .filter((p) => p.nextAttemptAt.getTime() <= now.getTime())
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);
  }

  async ack(matchId: string): Promise<void> {
    await this.ackScript(this.pendingKey, this.deliveredKey, matchId, this.options.deliveredRetentionSeconds * 1000);
  }

  async count(): Promise<number> {
    return this.redis.hlen(this.pendingKey);
  }

  async retryLater(pending: PendingMatch): Promise<void> {
    await this.retryScript(this.pendingKey, pending.match.id, encodeWithDates(pending));
  }
}
