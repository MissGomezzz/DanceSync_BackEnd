import { Router, type NextFunction, type Request, type Response } from "express";
import type { CreateRoom } from "../../application/usecases/CreateRoom.js";
import { DomainError, type DomainErrorCode } from "../../domain/errors/DomainError.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";

export interface HttpDependencies {
  createRoom: CreateRoom;
  rooms: RoomRepository;
}

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  ROOM_NOT_FOUND: 404,
  ROOM_FULL: 409,
  ROOM_NOT_WAITING: 409,
  ROOM_NOT_BATTLING: 409,
  PLAYER_ALREADY_IN_ROOM: 409,
  PLAYER_NOT_IN_ROOM: 403,
  NOT_ENOUGH_PLAYERS: 409,
  INVALID_DANCER: 400,
  INVALID_RATER: 403,
  INVALID_SCORE: 400,
  DUPLICATE_RATING: 409,
  INVALID_MESSAGE: 400,
};

export function buildRouter(deps: HttpDependencies): Router {
  const router = Router();

  router.get("/api/battles/health", (_req, res) => {
    res.json({ status: "UP", service: "battle-service" });
  });

  router.post("/api/rooms", async (req, res, next) => {
    try {
      const { hostId, displayName } = (req.body ?? {}) as Partial<{ hostId: string; displayName: string }>;
      if (!isNonEmptyString(hostId) || !isNonEmptyString(displayName)) {
        res.status(400).json({ error: "hostId and displayName are required" });
        return;
      }
      const room = await deps.createRoom.execute({ hostId, displayName });
      res.status(201).location(`/api/rooms/${room.code}`).json(room);
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
      res.json(room);
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
  console.error("Unhandled error", error);
  res.status(500).json({ error: "Internal server error" });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
