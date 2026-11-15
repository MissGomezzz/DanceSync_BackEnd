package com.dancesync.users.infrastructure.observability;

import org.springframework.boot.health.actuate.endpoint.HealthEndpoint;
import org.springframework.boot.health.contributor.Status;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Keeps {@code GET /actuator/health} answering on the API port (OBS-1). The actuator moved
 * to its own management port (prometheus, health), but the probes and scripts that already
 * call the API port (the DIS-1 failover harness, platform probes) keep working. Only the
 * overall status is returned, never the details.
 */
@RestController
public class ApiPortHealthController {

    private final HealthEndpoint healthEndpoint;

    public ApiPortHealthController(HealthEndpoint healthEndpoint) {
        this.healthEndpoint = healthEndpoint;
    }

    @GetMapping("/actuator/health")
    public ResponseEntity<Map<String, String>> health() {
        Status status = healthEndpoint.health().getStatus();
        return ResponseEntity.status(Status.UP.equals(status) ? 200 : 503).body(Map.of("status", status.getCode()));
    }
}
