import { Router, type NextFunction, type Request, type Response } from "express";
import type { CreateRoom } from "../../application/usecases/CreateRoom.js";
import { DomainError, type DomainErrorCode } from "../../domain/errors/DomainError.js";
import type { Room } from "../../domain/model/Room.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { toRoomDto } from "../serialization/roomDto.js";

export interface HttpDependencies {
  createRoom: CreateRoom;
  rooms: RoomRepository;
  /** Notified after a room is created, so a room whose host never connects can be reaped. */
  onRoomCreated?: (room: Room) => void;
}

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
  INVALID_RATER: 403,
  NOT_HOST: 403,
  INVALID_SCORE: 400,
  DUPLICATE_RATING: 409,
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

  return router;
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
