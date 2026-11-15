import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Logger } from "../../application/ports/Logger.js";
import { rootLogger } from "../logging/logger.js";

/** One finished HTTP request, as the access log and the metrics see it. */
export interface HttpRequestObservation {
  method: string;
  /** The route template (e.g. /api/rooms/:code), never the raw path: a bounded label. */
  route: string;
  status: number;
  durationSeconds: number;
}

export interface AccessLogOptions {
  logger?: Logger;
  /** Called once per finished request (metrics). */
  observe?: (request: HttpRequestObservation) => void;
}

/** Probes polled every few seconds by Docker, nginx and the platform: debug level, not info. */
const PROBE_ROUTES = new Set(["/api/battles/health", "/api/battles/health/ready"]);

/**
 * One access log line per HTTP request (OBS-1), written when the response is
 * finished: correlation id (set by the router's correlation middleware), method,
 * route template, status and duration. Mount it before every other middleware.
 * The query string, headers and body are never logged.
 */
export function createAccessLog({ logger = rootLogger, observe }: AccessLogOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const startedAt = process.hrtime.bigint();
    res.once("finish", () => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const route = routeOf(req);
      const fields = {
        correlationId: res.locals.correlationId as string | undefined,
        method: req.method,
        route,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationSeconds * 100_000) / 100,
      };
      if (PROBE_ROUTES.has(route) && res.statusCode < 400) logger.debug(fields, "HTTP request");
      else logger.info(fields, "HTTP request");
      observe?.({ method: req.method, route, status: res.statusCode, durationSeconds });
    });
    next();
  };
}

/** The matched route template, or "unmatched" (404s, CORS preflights) so labels stay bounded. */
export function routeOf(req: Request): string {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? `${req.baseUrl}${path}` : "unmatched";
}
