import type { Redis } from "ioredis";

/** A Lua script registered on one connection: runs by hash and reloads itself when Redis lost it. */
export type ScriptRunner = (key: string, ...args: Array<string | number>) => Promise<unknown>;

/**
 * Registers `lua` as a single-key command. Lua runs atomically inside Redis,
 * which is what makes each compare-and-set below a single indivisible step even
 * with several service instances (and a single shared connection: unlike
 * WATCH/MULTI, nothing here depends on connection-level state).
 */
export function defineScript(redis: Redis, name: string, lua: string): ScriptRunner {
  redis.defineCommand(name, { numberOfKeys: 1, lua });
  const commands = redis as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  return (key, ...args) => commands[name](key, ...args);
}
