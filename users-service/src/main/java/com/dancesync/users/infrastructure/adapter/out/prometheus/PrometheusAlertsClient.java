package com.dancesync.users.infrastructure.adapter.out.prometheus;

import com.dancesync.users.domain.model.audit.AdminAlert;
import com.dancesync.users.domain.port.out.OperationalAlertsPort;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Reads the active alerts of the OBS-1 rules from the Prometheus HTTP API
 * ({@code GET /api/v1/alerts}), so the admin sees them next to the security alerts without
 * opening Prometheus or Grafana. Read-only; nothing is sent to Prometheus but the request.
 */
public class PrometheusAlertsClient implements OperationalAlertsPort {

    private static final Duration TIMEOUT = Duration.ofSeconds(3);

    private final RestClient client;

    /** @param baseUrl Prometheus' address (PROMETHEUS_URL), or blank when there is none */
    public PrometheusAlertsClient(String baseUrl) {
        if (baseUrl == null || baseUrl.isBlank()) {
            this.client = null;
            return;
        }
        SimpleClientHttpRequestFactory requests = new SimpleClientHttpRequestFactory();
        requests.setConnectTimeout(TIMEOUT);
        requests.setReadTimeout(TIMEOUT);
        this.client = RestClient.builder().baseUrl(withoutTrailingSlashes(baseUrl.trim())).requestFactory(requests).build();
    }

    /** Drops trailing slashes with a plain scan (a "/+$" regex backtracks quadratically on long inputs). */
    static String withoutTrailingSlashes(String url) {
        int end = url.length();
        while (end > 0 && url.charAt(end - 1) == '/') end--;
        return url.substring(0, end);
    }

    @Override
    public boolean configured() {
        return client != null;
    }

    @Override
    public List<AdminAlert> activeAlerts() {
        if (client == null) return List.of();
        AlertsResponse response = client.get().uri("/api/v1/alerts").retrieve().body(AlertsResponse.class);
        if (response == null || response.data() == null || response.data().alerts() == null) return List.of();
        return response.data().alerts().stream().map(PrometheusAlertsClient::toAlert).toList();
    }

    private static AdminAlert toAlert(PromAlert alert) {
        Map<String, String> labels = alert.labels() == null ? Map.of() : new TreeMap<>(alert.labels());
        Map<String, String> annotations = alert.annotations() == null ? Map.of() : alert.annotations();
        String name = labels.getOrDefault("alertname", "Alert");
        String instance = labels.getOrDefault("instance", labels.getOrDefault("job", ""));
        Map<String, String> context = new TreeMap<>(labels);
        context.remove("alertname");
        context.remove("severity");
        if (alert.value() != null) context.put("value", alert.value());
        return new AdminAlert(
                "prometheus:" + name + ":" + instance,
                "prometheus",
                name,
                labels.getOrDefault("severity", "warning"),
                alert.state() == null ? "firing" : alert.state(),
                annotations.getOrDefault("summary", name),
                annotations.get("description"),
                parse(alert.activeAt()),
                context);
    }

    private static Instant parse(String value) {
        if (value == null) return null;
        try {
            return Instant.parse(value);
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    record AlertsResponse(String status, AlertsData data) {
    }

    record AlertsData(List<PromAlert> alerts) {
    }

    record PromAlert(Map<String, String> labels, Map<String, String> annotations, String state, String activeAt,
                     String value) {
    }
}
