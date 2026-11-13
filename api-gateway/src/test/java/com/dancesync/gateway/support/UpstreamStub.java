package com.dancesync.gateway.support;

import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Stands in for a downstream service (users-service or battle-service): it
 * answers 200 to everything and records what reached it, so a test can prove
 * that a refused request was never forwarded.
 */
public final class UpstreamStub {

    /** One request that reached the service. */
    public record Received(String method, String pathAndQuery, String authorization, String correlationId) {
    }

    private final List<Received> received = new CopyOnWriteArrayList<>();
    private final HttpServer server;

    public UpstreamStub() {
        try {
            server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
            server.createContext("/", exchange -> {
                URI uri = exchange.getRequestURI();
                received.add(new Received(
                        exchange.getRequestMethod(),
                        uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery()),
                        exchange.getRequestHeaders().getFirst("Authorization"),
                        exchange.getRequestHeaders().getFirst("X-Correlation-Id")));
                exchange.getRequestBody().readAllBytes();
                byte[] body = "{\"stub\":true}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, body.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(body);
                }
            });
            server.start();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public String url() {
        return "http://localhost:" + server.getAddress().getPort();
    }

    public List<Received> received() {
        return received;
    }

    /** "METHOD path?query" of every request received, in order. */
    public List<String> requests() {
        return received.stream().map(r -> r.method() + " " + r.pathAndQuery()).toList();
    }

    public void clear() {
        received.clear();
    }

    public void stop() {
        server.stop(0);
    }
}
