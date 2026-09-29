import type { ChatMessage } from "../../domain/model/ChatMessage.js";
import type { Room } from "../../domain/model/Room.js";

/** Events emitted by clients. */
export const ClientEvents = {
  ROOM_JOIN: "room:join",
  ROOM_LEAVE: "room:leave",
  BATTLE_START: "battle:start",
  CHAT_MESSAGE: "chat:message",
  RATING_SUBMIT: "rating:submit",
  WEBRTC_READY: "webrtc:ready",
  WEBRTC_SIGNAL: "webrtc:signal",
} as const;

/** Events emitted by the server. */
export const ServerEvents = {
  ROOM_UPDATED: "room:updated",
  BATTLE_STARTED: "battle:started",
  CHAT_MESSAGE: "chat:message",
  BATTLE_FINISHED: "battle:finished",
  WEBRTC_PEER_READY: "webrtc:peer-ready",
  WEBRTC_SIGNAL: "webrtc:signal",
  ERROR: "error:domain",
} as const;

export interface RoomJoinPayload {
  roomCode: string;
  playerId: string;
  displayName: string;
}

export interface RoomLeavePayload {
  roomCode: string;
  playerId: string;
}

export interface BattleStartPayload {
  roomCode: string;
  requesterId: string;
  dancerIds?: [string, string];
}

export interface ChatMessagePayload {
  roomCode: string;
  senderId: string;
  content: string;
}

export interface RatingSubmitPayload {
  roomCode: string;
  raterId: string;
  dancerId: string;
  score: number;
}

/**
 * WebRTC signaling. The server only validates membership and relays opaque
 * session descriptions and ICE candidates; media never passes through it.
 */
export interface WebRtcReadyPayload {
  roomCode: string;
  playerId: string;
}

export interface WebRtcPeerReadyPayload {
  playerId: string;
}

export interface WebRtcSessionDescription {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
}

/** Mirrors the browser RTCIceCandidateInit dictionary. */
export interface WebRtcIceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface WebRtcSignalPayload {
  roomCode: string;
  from: string;
  to: string;
  /** Identifies one peer connection; answers and candidates echo the offer's id. */
  negotiationId: string;
  description?: WebRtcSessionDescription;
  candidate?: WebRtcIceCandidate;
}

export interface DomainErrorPayload {
  code: string;
  message: string;
}

/** Acknowledgement callback shape shared by every client event. */
export type Ack<T> = (response: { ok: true; data: T } | { ok: false; error: DomainErrorPayload }) => void;

export interface ClientToServerEvents {
  [ClientEvents.ROOM_JOIN]: (payload: RoomJoinPayload, ack?: Ack<Room>) => void;
  [ClientEvents.ROOM_LEAVE]: (payload: RoomLeavePayload, ack?: Ack<Room | null>) => void;
  [ClientEvents.BATTLE_START]: (payload: BattleStartPayload, ack?: Ack<Room>) => void;
  [ClientEvents.CHAT_MESSAGE]: (payload: ChatMessagePayload, ack?: Ack<ChatMessage>) => void;
  [ClientEvents.RATING_SUBMIT]: (payload: RatingSubmitPayload, ack?: Ack<Room>) => void;
  [ClientEvents.WEBRTC_READY]: (payload: WebRtcReadyPayload, ack?: Ack<null>) => void;
  [ClientEvents.WEBRTC_SIGNAL]: (payload: WebRtcSignalPayload, ack?: Ack<null>) => void;
}

export interface ServerToClientEvents {
  [ServerEvents.ROOM_UPDATED]: (room: Room) => void;
  [ServerEvents.BATTLE_STARTED]: (room: Room) => void;
  [ServerEvents.CHAT_MESSAGE]: (message: ChatMessage) => void;
  [ServerEvents.BATTLE_FINISHED]: (room: Room) => void;
  [ServerEvents.WEBRTC_PEER_READY]: (payload: WebRtcPeerReadyPayload) => void;
  [ServerEvents.WEBRTC_SIGNAL]: (payload: WebRtcSignalPayload) => void;
  [ServerEvents.ERROR]: (error: DomainErrorPayload) => void;
}

export interface SocketData {
  playerId?: string;
  roomCode?: string;
}
