/** Structured fields of a log line: ids, names, durations. Never tokens or secrets. */
export type LogFields = Record<string, unknown>;

/**
 * Outbound port for structured logs (OBS-1). Every line is one JSON object; the
 * fields go first and the message second, like pino, so the infrastructure
 * logger implements it as is. An error goes in the `err` field.
 */
export interface Logger {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  /** A logger that adds `fields` to every line it writes. */
  child(fields: LogFields): Logger;
}

/** Discards everything; for harnesses and as a safe default. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};
