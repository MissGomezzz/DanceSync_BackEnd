import express, { Router, type NextFunction, type Request, type Response } from "express";
import { AuthError } from "../../application/auth/AuthIdentity.js";
import type { CreateRoom } from "../../application/usecases/CreateRoom.js";
import type { IssueGuestToken } from "../../application/usecases/IssueGuestToken.js";
import { DomainError, type DomainErrorCode } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { requireRoomCode } from "../../domain/services/RoomService.js";
import { toRoomDto } from "../serialization/roomDto.js";
import { createHttpAuth, identityOf, type HttpAuth, type HttpAuthDependencies } from "./httpAuth.js";

export interface HttpDependencies {
  /** Token validation (SEG-1): every route but the health check and the guest token needs one. */
  auth: HttpAuthDependencies;
  /** Issues guest tokens; absent when GUEST_TOKEN_SECRET is not configured (the route answers 503). */
  issueGuestToken?: IssueGuestToken;
  createRoom: CreateRoom;
  rooms: RoomRepository;
  /** Notified after a room is created, so a room whose host never connects can be reaped. */
  onRoomCreated?: (room: Room) => void;
  /**
   * Runs the same departure as the room:leave socket event (seat released, host
   * handed over, battle settled, the player's sockets unbound, broadcasts).
   */
  leaveRoom?: (roomCode: string, playerId: string) => Promise<unknown>;
  /** Releases the seat after a short grace unless the player rejoins (a reload); see the leave route. */
  leaveAfterPagehide?: (roomCode: string, playerId: string) => void;
}

/** Why the client is leaving; see POST /api/rooms/:code/leave. */
type LeaveReason = "explicit" | "pagehide";

/** Largest leave request accepted; it only carries a token and a reason. */
const LEAVE_BODY_LIMIT = "8kb";

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  ROOM_NOT_FOUND: 404,
  ROOM_FULL: 409,
  ROOM_NOT_WAITING: 409,
  ROOM_NOT_BATTLING: 409,
  BATTLE_NOT_STARTED: 409,
  PLAYER_ALREADY_IN_ROOM: 409,
  PLAYER_NOT_IN_ROOM: 403,
  INVALID_PLAYER: 400,
  NOT_ENOUGH_PLAYERS: 409,
  NOT_ENOUGH_DANCERS: 409,
  INVALID_DANCER: 400,
  PLAYERS_NOT_READY: 409,
  SONG_NOT_SELECTED: 409,
  INVALID_VOTER: 403,
  BATTLE_FINISHED: 409,
  ROOM_NOT_FINISHED: 409,
  NOT_HOST: 403,
  INVALID_MESSAGE: 400,
  SONG_SELECTION_IN_PROGRESS: 409,
  SONG_SELECTION_NOT_ACTIVE: 409,
  NOT_CHALLENGE_PARTICIPANT: 403,
  ATTEMPT_ALREADY_USED: 409,
  NOT_SONG_CHOOSER: 403,
  INVALID_SONG: 400,
  WORD_RACE_NOT_ACTIVE: 409,
  WORD_ROUND_NOT_OPEN: 409,
};

export function buildRouter(deps: HttpDependencies): Router {
  const router = Router();
  const auth = createHttpAuth(deps.auth);
  router.use(auth.correlation);

  router.get("/api/battles/health", (_req, res) => {
    res.json({ status: "UP", service: "battle-service" });
  });

  // Registered users only: a guest token is refused with 403. The host is the
  // user in the token; a hostId in the body is ignored.
  router.post("/api/rooms", auth.require("registered"), async (req, res, next) => {
    try {
      const identity = identityOf(res);
      // CreateRoom validates the display name and answers INVALID_PLAYER (400) otherwise.
      const { displayName = identity.displayName } = (req.body ?? {}) as { displayName?: string };
      const room = await deps.createRoom.execute({ hostId: identity.playerId, displayName: displayName as string });
      deps.onRoomCreated?.(room);
      res.status(201).location(`/api/rooms/${room.code}`).json(toRoomDto(room, new Date()));
    } catch (error) {
      next(error);
    }
  });

  /**
   * Public on purpose: this is how someone without an account gets in. With the
   * code of an existing room and a display name they receive a short-lived
   * token, signed by this service and valid only for that room, plus the player
   * id it carries. It allows neither creating rooms nor reading the match history.
   */
  router.post("/api/rooms/:code/guest-token", async (req, res, next) => {
    try {
      if (!deps.issueGuestToken) {
        res.status(503).json({ error: "Guest access is not configured", code: "GUEST_ACCESS_UNAVAILABLE" });
        return;
      }
      const { displayName } = (req.body ?? {}) as { displayName: string };
      const guest = await deps.issueGuestToken.execute({ roomCode: req.params.code, displayName });
      res.status(201).json({ ...guest, expiresAt: guest.expiresAt.toISOString() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/rooms/:code", auth.require("any"), async (req, res, next) => {
    try {
      auth.requireRoom(identityOf(res), String(req.params.code));
      const room = await deps.rooms.findByCode(String(req.params.code));
      if (!room) {
        res.status(404).json({ error: `Room ${req.params.code} does not exist` });
        return;
      }
      res.json(toRoomDto(room, new Date()));
    } catch (error) {
      next(error);
    }
  });

  /**
   * The player leaves the room (HU 22): { reason?: "explicit" | "pagehide", token? }.
   * The player is the one identified by the token, sent in the Authorization
   * header or, by the beacon (which cannot set headers), in the body.
   * - explicit (default): the same departure as the room:leave socket event, at
   *   once; 204.
   * - pagehide: sent by navigator.sendBeacon when the page is hidden. Browsers
   *   fire pagehide on a reload as well as on a tab close, so the seat is only
   *   released after a short grace (PAGEHIDE_GRACE_MS) if no socket of the
   *   player rejoined meanwhile; 202. A reload therefore keeps the seat, the
   *   host role and a running battle, while a closed tab frees them in seconds
   *   instead of after the disconnect grace.
   * A beacon cannot wait for a socket ack and sends its body as text/plain (a
   * JSON content type would need a CORS preflight a beacon cannot make), so the
   * body is accepted as JSON or as JSON text.
   */
  router.post(
    "/api/rooms/:code/leave",
    express.text({ type: "text/plain", limit: LEAVE_BODY_LIMIT }),
    async (req, res, next) => {
      try {
        if (!deps.leaveRoom) throw new Error("Leaving over HTTP is not wired");
        const roomCode = requireRoomCode(req.params.code).toUpperCase();
        const { token, reason } = readLeaveRequest(req.body);
        const identity = await auth.identify(req, "any", token);
        auth.requireRoom(identity, roomCode);
        const playerId = identity.playerId;
        if (reason === "explicit") {
          await deps.leaveRoom(roomCode, playerId);
          res.status(204).end();
          return;
        }
        if (!deps.leaveAfterPagehide) throw new Error("Leaving after a pagehide is not wired");
        // Answer 404 / 403 now, like an immediate leave, rather than arming a useless timer.
        const room = await deps.rooms.findByCode(roomCode);
        if (!room) throw new DomainError("ROOM_NOT_FOUND", `Room ${roomCode} does not exist`);
        if (!room.players.some((p) => p.id === playerId)) {
          throw new DomainError("PLAYER_NOT_IN_ROOM", `Player ${playerId} is not in room ${roomCode}`);
        }
        deps.leaveAfterPagehide(roomCode, playerId);
        res.status(202).end();
      } catch (error) {
        next(error);
      }
    },
  );

  router.use(authErrorHandler(auth));
  return router;
}

/** Answers 401 / 403 for the router's own routes and records the attempt; other errors go on. */
function authErrorHandler(auth: HttpAuth) {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (error instanceof AuthError) auth.refuse(error, req, res);
    else next(error);
  };
}

/** The token (when sent in the body) and reason of a leave request, from a parsed JSON body or JSON sent as text. */
function readLeaveRequest(body: unknown): { token: string | undefined; reason: LeaveReason } {
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new DomainError("INVALID_MESSAGE", "The body must be JSON: { reason?, token? }");
    }
  }
  const { token, reason = "explicit" } =
    typeof parsed === "object" && parsed !== null ? (parsed as { token?: unknown; reason?: unknown }) : {};
  if (reason !== "explicit" && reason !== "pagehide") {
    throw new DomainError("INVALID_MESSAGE", 'reason must be "explicit" or "pagehide"');
  }
  if (token !== undefined && typeof token !== "string") {
    throw new DomainError("INVALID_MESSAGE", "token must be a string");
  }
  return { token: token || undefined, reason };
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof DomainError) {
    res.status(STATUS_BY_CODE[error.code] ?? 400).json({ error: error.message, code: error.code });
    return;
  }
  // Errors raised by Express middleware (express.json and friends) carry the
  // client error status they mean: a malformed body is the client's fault, not a 500.
  const clientStatus = clientErrorStatus(error);
  if (clientStatus !== null) {
    const isParseError = (error as { type?: unknown }).type === "entity.parse.failed";
    res.status(clientStatus).json({ error: isParseError ? "Malformed JSON body" : "Invalid request" });
    return;
  }
  console.error("Unhandled error", error);
  res.status(500).json({ error: "Internal server error" });
}

/** The 4xx status of a middleware error (body-parser sets `status`/`statusCode`), or null. */
function clientErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const { type, status, statusCode } = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  const code = typeof status === "number" ? status : typeof statusCode === "number" ? statusCode : null;
  if (code !== null && Number.isInteger(code) && code >= 400 && code < 500) return code;
  return type === "entity.parse.failed" ? 400 : null;
}
