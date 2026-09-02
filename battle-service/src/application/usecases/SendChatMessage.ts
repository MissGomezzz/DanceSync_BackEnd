import { randomUUID } from "node:crypto";
import { DomainError } from "../../domain/errors/DomainError.js";
import { MAX_MESSAGE_LENGTH, type ChatMessage } from "../../domain/model/ChatMessage.js";
import type { RoomRepository } from "../../domain/ports/RoomRepository.js";

export interface SendChatMessageInput {
  roomCode: string;
  senderId: string;
  content: string;
}

export class SendChatMessage {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(input: SendChatMessageInput): Promise<ChatMessage> {
    const room = await this.rooms.findByCode(input.roomCode);
    if (!room) throw new DomainError("ROOM_NOT_FOUND", `Room ${input.roomCode} does not exist`);

    const sender = room.players.find((p) => p.id === input.senderId);
    if (!sender) {
      throw new DomainError("PLAYER_NOT_IN_ROOM", `Player ${input.senderId} is not in room ${room.code}`);
    }

    const content = input.content.trim();
    if (content.length === 0 || content.length > MAX_MESSAGE_LENGTH) {
      throw new DomainError("INVALID_MESSAGE", `Message must be between 1 and ${MAX_MESSAGE_LENGTH} characters`);
    }

    return {
      id: randomUUID(),
      roomCode: room.code,
      senderId: sender.id,
      senderName: sender.displayName,
      content,
      sentAt: new Date(),
    };
  }
}
