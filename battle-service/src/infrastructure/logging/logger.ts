import { hostname } from "node:os";
import { pino, type DestinationStream, type Logger as PinoLogger } from "pino";
import type { Logger } from "../../application/ports/Logger.js";

export const SERVICE_NAME = "battle-service";

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

/**
 * LOG_LEVEL when set; otherwise "info", or "silent" inside the Node test runner
 * (NODE_TEST_CONTEXT) so test output stays readable. Tests that check a log
 * line inject their own logger.
 */
export function logLevelFrom(source: Record<string, string | undefined> = process.env): string {
  const requested = source.LOG_LEVEL?.trim().toLowerCase();
  if (requested && LEVELS.has(requested)) return requested;
  return source.NODE_TEST_CONTEXT ? "silent" : "info";
}

/**
 * One JSON object per line on stdout (OBS-1): `level` as a word, `timestamp`
 * as an ISO-8601 instant, `service` and the replica (`instance`, the container
 * hostname) on every line, so `docker compose logs` and Log Analytics can be
 * searched by correlationId across replicas. Tokens, the guest secret and the
 * Redis password are never passed to it (same rule as the audit lines).
 */
export function createLogger(options: { level?: string; destination?: DestinationStream } = {}): PinoLogger {
  const settings = {
    level: options.level ?? logLevelFrom(),
    base: { service: SERVICE_NAME, instance: hostname() },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: { level: (label: string) => ({ level: label }) },
    messageKey: "message",
  };
  return options.destination ? pino(settings, options.destination) : pino(settings);
}

/** The process-wide logger; adapters default to it, tests inject their own. */
export const rootLogger: Logger = createLogger();
