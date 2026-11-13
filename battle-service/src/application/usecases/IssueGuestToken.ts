import { randomUUID } from "node:crypto";
import type { GuestTokenIssuer } from "../auth/AuthIdentity.js";
import { DomainError } from "../../domain/errors/DomainError.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";
import { requireRoomCode, validatePlayer } from "../../domain/services/RoomService.js";

export interface IssueGuestTokenInput {
  roomCode: string;
  displayName: string;
}

export interface IssueGuestTokenOutput {
  token: string;
  playerId: string;
  displayName: string;
  roomCode: string;
  expiresAt: Date;
}

/**
 * Lets someone without an account join a room they have the code of (SEG-1):
 * they get a short-lived token signed by this service and valid only for that
 * room. The player id is generated here, so a guest can never pick (or reuse)
 * somebody else's identity.
 */
export class IssueGuestToken {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly issuer: GuestTokenIssuer,
  ) {}

  /** Throws ROOM_NOT_FOUND for an unknown code and INVALID_PLAYER for a bad display name. */
  async execute(input: IssueGuestTokenInput, now: Date = new Date()): Promise<IssueGuestTokenOutput> {
    const requested = requireRoomCode(input.roomCode);
    const guest = validatePlayer(`guest-${randomUUID()}`, input.displayName);
    const room = await this.rooms.findByCode(requested);
    if (!room) throw new DomainError("ROOM_NOT_FOUND", `Room ${requested} does not exist`);
    const { token, expiresAt } = await this.issuer.issue(
      { playerId: guest.id, displayName: guest.displayName, roomCode: room.code },
      now,
    );
    return { token, playerId: guest.id, displayName: guest.displayName, roomCode: room.code, expiresAt };
  }
}
