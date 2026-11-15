import type { LogFields, Logger } from "../../src/application/ports/Logger.js";

export interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: LogFields;
}

/** A Logger that keeps every line in memory (children included), for tests that check what is logged. */
export class RecordingLogger implements Logger {
  constructor(
    readonly lines: LogLine[] = [],
    private readonly bindings: LogFields = {},
  ) {}

  debug(fields: LogFields, message: string): void {
    this.write("debug", fields, message);
  }
  info(fields: LogFields, message: string): void {
    this.write("info", fields, message);
  }
  warn(fields: LogFields, message: string): void {
    this.write("warn", fields, message);
  }
  error(fields: LogFields, message: string): void {
    this.write("error", fields, message);
  }
  child(fields: LogFields): Logger {
    return new RecordingLogger(this.lines, { ...this.bindings, ...fields });
  }

  /** Lines with this message. */
  find(message: string): LogLine[] {
    return this.lines.filter((line) => line.message === message);
  }

  private write(level: LogLine["level"], fields: LogFields, message: string): void {
    this.lines.push({ level, message, fields: { ...this.bindings, ...fields } });
  }
}
