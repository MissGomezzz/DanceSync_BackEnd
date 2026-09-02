export const MAX_MESSAGE_LENGTH = 500;

export interface ChatMessage {
  id: string;
  roomCode: string;
  senderId: string;
  senderName: string;
  content: string;
  sentAt: Date;
}
