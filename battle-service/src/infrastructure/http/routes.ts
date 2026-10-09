import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { CreateRoom } from "../../application/usecases/CreateRoom.js";
import { DomainError, type DomainErrorCode } from "../../domain/errors/DomainError.js";
import { MAX_PLAYER_ID_LENGTH } from "../../domain/model/Player.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { requireRoomCode } from "../../domain/services/RoomService.js";
import { toRoomDto } from "../serialization/roomDto.js";

export interface HttpDependencies {
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

/** Largest leave request accepted; it only carries a player id. */
const LEAVE_BODY_LIMIT = "1kb";

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

  router.get("/api/battles/health", (_req, res) => {
    res.json({ status: "UP", service: "battle-service" });
  });

  router.post("/api/rooms", async (req, res, next) => {
    try {
      // CreateRoom validates both fields and answers INVALID_PLAYER (400) otherwise.
      const { hostId, displayName } = (req.body ?? {}) as { hostId: string; displayName: string };
      const room = await deps.createRoom.execute({ hostId, displayName });
      deps.onRoomCreated?.(room);
      res.status(201).location(`/api/rooms/${room.code}`).json(toRoomDto(room, new Date()));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/rooms/:code", async (req, res, next) => {
    try {
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
   * The player leaves the room (HU 22): { playerId, reason?: "explicit" | "pagehide" }.
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
   * body is accepted as JSON or as JSON text. Identity is the mocked guest id,
   * like every other action until Entra ID.
   */
  router.post(
    "/api/rooms/:code/leave",
    express.text({ type: "text/plain", limit: LEAVE_BODY_LIMIT }),
    async (req, res, next) => {
      try {
        if (!deps.leaveRoom) throw new Error("Leaving over HTTP is not wired");
        const roomCode = requireRoomCode(req.params.code).toUpperCase();
        const { playerId, reason } = readLeaveRequest(req.body);
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

  return router;
}

/** The player id and reason of a leave request, from a parsed JSON body or JSON sent as text. */
function readLeaveRequest(body: unknown): { playerId: string; reason: LeaveReason } {
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new DomainError("INVALID_MESSAGE", "The body must be JSON: { playerId }");
    }
  }
  const { playerId, reason = "explicit" } =
    typeof parsed === "object" && parsed !== null ? (parsed as { playerId?: unknown; reason?: unknown }) : {};
  if (
    typeof playerId !== "string" ||
    playerId.length === 0 ||
    playerId.length > MAX_PLAYER_ID_LENGTH ||
    playerId.trim() !== playerId
  ) {
    throw new DomainError("INVALID_PLAYER", `playerId must be 1-${MAX_PLAYER_ID_LENGTH} characters without surrounding spaces`);
  }
  if (reason !== "explicit" && reason !== "pagehide") {
    throw new DomainError("INVALID_MESSAGE", 'reason must be "explicit" or "pagehide"');
  }
  return { playerId, reason };
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
