import type { Metrics } from "../../application/ports/Metrics.js";
import type { AbuseAuditLog } from "../abuse/abuseAudit.js";
import type { AuthAuditLog } from "../auth/authAudit.js";

/**
 * Counts every refused authentication next to its audit line (OBS-1), without
 * touching the audit log itself (SEG-1, owned by its own scope): the audit
 * line is written exactly as before.
 */
export function countingAuthAudit(audit: AuthAuditLog, metrics: Metrics): AuthAuditLog {
  return {
    rejected(entry) {
      metrics.authRejected(entry.channel);
      audit.rejected(entry);
    },
  };
}

/** Counts every abuse incident (SEG-3) next to its audit line, which is written exactly as before. */
export function countingAbuseAudit(audit: AbuseAuditLog, metrics: Metrics): AbuseAuditLog {
  return {
    limited(incident) {
      metrics.abuse("limited");
      audit.limited(incident);
    },
    blocked(incident) {
      metrics.abuse("blocked");
      audit.blocked(incident);
    },
    refused(incident) {
      metrics.abuse("refused");
      audit.refused(incident);
    },
  };
}
