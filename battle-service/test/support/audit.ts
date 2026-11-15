import type { AuditEntry, AuditTrail } from "../../src/application/ports/AuditTrail.js";

/** Keeps every audit entry in memory, for the SEG-2 suites. */
export class RecordingAuditTrail implements AuditTrail {
  readonly entries: AuditEntry[] = [];

  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }

  /** Entries of this action, in order. */
  of(action: string): AuditEntry[] {
    return this.entries.filter((entry) => entry.action === action);
  }

  serialized(): string {
    return JSON.stringify(this.entries);
  }

  clear(): void {
    this.entries.length = 0;
  }
}
