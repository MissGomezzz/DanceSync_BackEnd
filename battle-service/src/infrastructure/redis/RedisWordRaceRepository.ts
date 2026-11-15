import type { Redis } from "ioredis";
import type { WordRace, WordRound, WordRoundStatus } from "../../domain/model/WordRace.js";
import type { ClaimRoundResult, WordRaceRepository } from "../../domain/ports/WordRaceRepository.js";
import { defineScript, type ScriptRunner } from "./luaScripts.js";

/**
 * A race is a hash `wordrace:{CODE}`:
 *   meta        JSON with everything that never changes after the race is planned
 *   s:<round>   status of a round (scheduled | open | won | expired)
 *   w:<round>   winner of a round, present only once it was won
 *   c:<round>   closesAt in epoch ms, copied here so Lua can compare it
 *   n:<player>  rounds won by a dancer
 * The moving parts are plain fields, so each transition is one small Lua script
 * that never has to re-encode JSON.
 *
 * Every script answers { applied, status, winner, meta } so the caller gets the
 * round exactly as it was left by the step it just tried, in a single round trip.
 */
const RESULT = `return { applied, redis.call('HGET', k, 's:'..id), redis.call('HGET', k, 'w:'..id), meta }`;

/**
 * DIS-1: the instant a claim or an expiry is decided at. An empty argument means
 * "now" by the Redis server's clock (TIME), the same for every replica, so the
 * claim and expiry windows never depend on which replica's clock asks. Tests
 * pass an explicit epoch-ms value. TIME is allowed before writes because Redis 7
 * replicates scripts by their effects.
 */
const NOW = (arg: string) => `
local now = tonumber(${arg})
if not now then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end`;

/** scheduled -> open */
const OPEN = `
local k, id = KEYS[1], ARGV[1]
local meta = redis.call('HGET', k, 'meta')
if not meta then return { 0, false, false, false } end
local applied = 0
if redis.call('HGET', k, 's:'..id) == 'scheduled' then
  redis.call('HSET', k, 's:'..id, 'open')
  applied = 1
end
${RESULT}`;

/** open and unclaimed and before closesAt -> won (and one more win for the player), in one step. */
const CLAIM = `
local k, id = KEYS[1], ARGV[1]
${NOW("ARGV[3]")}
local meta = redis.call('HGET', k, 'meta')
if not meta then return { 0, false, false, false } end
local applied = 0
if redis.call('HGET', k, 's:'..id) == 'open' and not redis.call('HGET', k, 'w:'..id) then
  local closes = tonumber(redis.call('HGET', k, 'c:'..id))
  if now < closes then
    redis.call('HSET', k, 's:'..id, 'won', 'w:'..id, ARGV[2])
    redis.call('HINCRBY', k, 'n:'..ARGV[2], 1)
    applied = 1
  end
end
${RESULT}`;

/** open and unclaimed and at or after closesAt -> expired: the complement of the claim condition. */
const EXPIRE = `
local k, id = KEYS[1], ARGV[1]
${NOW("ARGV[2]")}
local meta = redis.call('HGET', k, 'meta')
if not meta then return { 0, false, false, false } end
local applied = 0
if redis.call('HGET', k, 's:'..id) == 'open' and not redis.call('HGET', k, 'w:'..id) then
  local closes = tonumber(redis.call('HGET', k, 'c:'..id))
  if now >= closes then
    redis.call('HSET', k, 's:'..id, 'expired')
    applied = 1
  end
end
${RESULT}`;

interface RaceMeta {
  roomCode: string;
  battleId: string;
  participantIds: string[];
  participantNames: Record<string, string>;
  rounds: Array<{ id: string; number: number; word: string; opensAt: number; closesAt: number }>;
}

type ScriptReply = [applied: number, status: string | null, winner: string | null, meta: string | null];

export class RedisWordRaceRepository implements WordRaceRepository {
  private readonly openScript: ScriptRunner;
  private readonly claimScript: ScriptRunner;
  private readonly expireScript: ScriptRunner;

  constructor(
    private readonly redis: Redis,
    private readonly options: { ttlSeconds: number },
  ) {
    this.openScript = defineScript(redis, "dsRaceOpen", OPEN);
    this.claimScript = defineScript(redis, "dsRaceClaim", CLAIM);
    this.expireScript = defineScript(redis, "dsRaceExpire", EXPIRE);
  }

  async save(race: WordRace): Promise<void> {
    const key = raceKey(race.roomCode);
    const meta: RaceMeta = {
      roomCode: race.roomCode,
      battleId: race.battleId,
      participantIds: race.participantIds,
      participantNames: race.participantNames,
      rounds: race.rounds.map((r) => ({
        id: r.id,
        number: r.number,
        word: r.word,
        opensAt: r.opensAt.getTime(),
        closesAt: r.closesAt.getTime(),
      })),
    };
    const fields: Record<string, string> = { meta: JSON.stringify(meta) };
    for (const round of race.rounds) {
      fields[`s:${round.id}`] = round.status;
      fields[`c:${round.id}`] = String(round.closesAt.getTime());
      if (round.winnerId !== null) fields[`w:${round.id}`] = round.winnerId;
    }
    for (const [playerId, wins] of Object.entries(race.wins)) fields[`n:${playerId}`] = String(wins);

    // Replaces any earlier race of the room as one step.
    const results = await this.redis.multi().del(key).hset(key, fields).expire(key, this.options.ttlSeconds).exec();
    for (const [error] of results ?? []) if (error) throw error;
  }

  async find(roomCode: string): Promise<WordRace | undefined> {
    const fields = await this.redis.hgetall(raceKey(roomCode));
    if (!fields.meta) return undefined;
    const meta = JSON.parse(fields.meta) as RaceMeta;
    const wins: Record<string, number> = {};
    for (const [name, value] of Object.entries(fields)) {
      if (name.startsWith("n:")) wins[name.slice(2)] = Number(value);
    }
    return {
      roomCode: meta.roomCode,
      battleId: meta.battleId,
      participantIds: meta.participantIds,
      participantNames: meta.participantNames,
      rounds: meta.rounds.map((r) => toRound(meta, r.id, (fields[`s:${r.id}`] ?? "scheduled") as WordRoundStatus, fields[`w:${r.id}`] ?? null)!),
      wins,
    };
  }

  async delete(roomCode: string): Promise<void> {
    await this.redis.del(raceKey(roomCode));
  }

  async openRound(roomCode: string, roundId: string): Promise<WordRound | null> {
    const reply = (await this.openScript(raceKey(roomCode), roundId)) as ScriptReply;
    return reply[0] === 1 ? roundFrom(reply, roundId) : null;
  }

  async claimRound(roomCode: string, roundId: string, playerId: string, now?: Date): Promise<ClaimRoundResult> {
    const reply = (await this.claimScript(raceKey(roomCode), roundId, playerId, instant(now))) as ScriptReply;
    const round = roundFrom(reply, roundId);
    return reply[0] === 1 && round ? { claimed: true, round } : { claimed: false, round };
  }

  async expireRound(roomCode: string, roundId: string, now?: Date): Promise<WordRound | null> {
    const reply = (await this.expireScript(raceKey(roomCode), roundId, instant(now))) as ScriptReply;
    return reply[0] === 1 ? roundFrom(reply, roundId) : null;
  }
}

/** Epoch ms of an explicit instant, or "" to let the script use the Redis server's clock. */
function instant(now: Date | undefined): string {
  return now === undefined ? "" : String(now.getTime());
}

function raceKey(roomCode: string): string {
  return `wordrace:{${roomCode.toUpperCase()}}`;
}

/** The round named by a script reply, or null when the race or the round does not exist. */
function roundFrom(reply: ScriptReply, roundId: string): WordRound | null {
  const [, status, winner, metaJson] = reply;
  if (!metaJson || !status) return null;
  return toRound(JSON.parse(metaJson) as RaceMeta, roundId, status as WordRoundStatus, winner);
}

function toRound(meta: RaceMeta, id: string, status: WordRoundStatus, winnerId: string | null): WordRound | null {
  const planned = meta.rounds.find((r) => r.id === id);
  if (!planned) return null;
  return {
    id: planned.id,
    number: planned.number,
    word: planned.word,
    opensAt: new Date(planned.opensAt),
    closesAt: new Date(planned.closesAt),
    winnerId,
    status,
  };
}
