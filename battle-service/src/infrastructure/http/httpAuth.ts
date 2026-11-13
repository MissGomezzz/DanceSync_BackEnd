import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AuthError, mayActInRoom, type AuthIdentity, type TokenVerifier } from "../../application/auth/AuthIdentity.js";
import { CORRELATION_HEADER, correlationIdFrom, consoleAuthAudit, type AuthAuditLog } from "../auth/authAudit.js";

export interface HttpAuthDependencies {
  verifier: TokenVerifier;
  /** Default: one JSON line per rejection on stderr. */
  audit?: AuthAuditLog;
}

/** Who may call a route: any valid token, or only a user signed in with Entra ID. */
type Access = "any" | "registered";

export interface HttpAuth {
  /** Reuses the gateway's correlation id (or creates one) and echoes it in the response. */
  correlation: RequestHandler;
  /** Requires a valid Bearer token; the identity is then available through identityOf(res). */
  require(access: Access): RequestHandler;
  /**
   * Validates `token` (the Bearer header when omitted) for routes that carry it
   * elsewhere, like the leave beacon. Throws AuthError.
   */
  identify(req: Request, access: Access, token?: string): Promise<AuthIdentity>;
  /** Throws FORBIDDEN unless the identity may act in the room (guests: only their own). */
  requireRoom(identity: AuthIdentity, roomCode: string): void;
  /** Records the refusal and answers 401 or 403; used by the error handler. */
  refuse(error: AuthError, req: Request, res: Response): void;
}

export function identityOf(res: Response): AuthIdentity {
  return res.locals.auth as AuthIdentity;
}

export function correlationIdOf(res: Response): string {
  return (res.locals.correlationId as string | undefined) ?? correlationIdFrom(undefined);
}

/**
 * Token validation for the HTTP routes (SEG-1). The api-gateway already
 * refuses requests without a valid token; validating again here keeps the
 * service safe when it is reached directly and is what makes the player id
 * come from the token instead of the request body.
 */
export function createHttpAuth({ verifier, audit = consoleAuthAudit }: HttpAuthDependencies): HttpAuth {
  async function identify(req: Request, access: Access, token = bearerToken(req)): Promise<AuthIdentity> {
    if (!token) throw new AuthError("UNAUTHORIZED", "missing_token");
    const identity = await verifier.verify(token);
    if (access === "registered" && identity.kind !== "user") {
      throw new AuthError("FORBIDDEN", "guest_out_of_scope", "Guests cannot do this; sign in first");
    }
    return identity;
  }

  return {
    correlation(req, res, next) {
      const correlationId = correlationIdFrom(req.headers[CORRELATION_HEADER]);
      res.locals.correlationId = correlationId;
      res.setHeader("X-Correlation-Id", correlationId);
      next();
    },
    require(access) {
      return (req: Request, res: Response, next: NextFunction) => {
        identify(req, access).then((identity) => {
          res.locals.auth = identity;
          next();
        }, next);
      };
    },
    identify,
    requireRoom(identity, roomCode) {
      if (!mayActInRoom(identity, roomCode)) {
        throw new AuthError("FORBIDDEN", "guest_out_of_scope", "A guest token is only valid for its own room");
      }
    },
    refuse(error, req, res) {
      const correlationId = correlationIdOf(res);
      // The path only: a query string could carry anything, the body and headers are never logged.
      audit.rejected({
        channel: "http",
        code: error.code,
        reason: error.reason,
        correlationId,
        method: req.method,
        path: req.path,
      });
      if (error.code === "UNAUTHORIZED") res.setHeader("WWW-Authenticate", "Bearer");
      res
        .status(error.code === "UNAUTHORIZED" ? 401 : 403)
        .json({ error: error.message, code: error.code, correlationId });
    },
  };
}

function bearerToken(req: Request): string | undefined {
  const match = /^Bearer +(\S+)$/i.exec(req.headers.authorization ?? "");
  return match?.[1];
}
