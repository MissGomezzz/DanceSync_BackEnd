package com.dancesync.users.domain.model.audit;

import java.time.Instant;
import java.util.Map;

/**
 * One alert on the admin screen. Operational alerts come from the Prometheus rules of OBS-1
 * (latency, errors, a replica down, the audit chain); security alerts are derived from the audit
 * log itself (repeated authentication failures from one address, clients blocked for flooding,
 * a broken chain).
 *
 * @param id       stable for the same condition, so the screen can keep its place
 * @param source   "prometheus" or "audit"
 * @param name     short rule name (e.g. BattleReplicaDown, RepeatedAuthFailures)
 * @param severity critical, warning or info
 * @param state    firing or pending
 * @param summary  one line for humans
 * @param since    when the condition started
 * @param labels   context (instance, ip, user...)
 */
public record AdminAlert(
        String id,
        String source,
        String name,
        String severity,
        String state,
        String summary,
        String description,
        Instant since,
        Map<String, String> labels) {
}
