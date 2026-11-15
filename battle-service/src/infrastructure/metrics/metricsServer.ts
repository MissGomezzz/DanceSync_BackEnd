import { createServer, type Server } from "node:http";
import type { Registry } from "prom-client";
import type { Logger } from "../../application/ports/Logger.js";
import { rootLogger } from "../logging/logger.js";

export const METRICS_PATH = "/metrics";

/**
 * Serves GET /metrics in the Prometheus text format on its own port (OBS-1,
 * METRICS_PORT). It is a separate HTTP server, never mounted on the public
 * Express app, and neither the gateway nor nginx route to it: only Prometheus,
 * inside the network, scrapes each replica directly.
 */
export function startMetricsServer(
  registry: Registry,
  port: number,
  logger: Logger = rootLogger,
): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET" || path !== METRICS_PATH) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
      return;
    }
    registry.metrics().then(
      (body) => res.writeHead(200, { "content-type": registry.contentType }).end(body),
      (error: unknown) => {
        logger.error({ err: error }, "Could not collect the metrics");
        res.writeHead(500, { "content-type": "text/plain" }).end("Metrics unavailable\n");
      },
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
