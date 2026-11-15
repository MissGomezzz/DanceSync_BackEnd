package com.dancesync.gateway.observability;

import org.springframework.boot.health.actuate.endpoint.HealthEndpoint;
import org.springframework.boot.health.contributor.Status;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.Map;

/**
 * Keeps {@code GET /actuator/health} answering on the gateway's public port (OBS-1). The
 * actuator moved to its own management port (health, prometheus, gateway), but the
 * platform probes and scripts that already call this one keep working, with the same open
 * security rule as before. Only the overall status is returned, never the details.
 */
@RestController
public class ApiPortHealthController {

    private final HealthEndpoint healthEndpoint;

    public ApiPortHealthController(HealthEndpoint healthEndpoint) {
        this.healthEndpoint = healthEndpoint;
    }

    @GetMapping("/actuator/health")
    public Mono<ResponseEntity<Map<String, String>>> health() {
        // Health indicators may block (a Redis ping): never on an event-loop thread.
        return Mono.fromCallable(() -> healthEndpoint.health().getStatus())
                .subscribeOn(Schedulers.boundedElastic())
                .map(status -> ResponseEntity.status(Status.UP.equals(status) ? 200 : 503)
                        .body(Map.of("status", status.getCode())));
    }
}
