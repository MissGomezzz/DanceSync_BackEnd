import type { ChatMessage } from "../../domain/model/ChatMessage.js";
import type { Room } from "../../domain/model/Room.js";
import type { SubmitWordOutcome } from "../../domain/model/WordRace.js";
import type { SubmitOutcome } from "../../domain/services/SongSelectionService.js";

/** Events emitted by clients. */
export const ClientEvents = {
  ROOM_JOIN: "room:join",
  ROOM_LEAVE: "room:leave",
  BATTLE_START: "battle:start",
  CHAT_MESSAGE: "chat:message",
  RATING_SUBMIT: "rating:submit",
  WEBRTC_READY: "webrtc:ready",
  WEBRTC_SIGNAL: "webrtc:signal",
  ROLE_SELECT: "role:select",
  SONG_CHALLENGE_START: "song-challenge:start",
  SONG_CHALLENGE_SUBMIT: "song-challenge:submit",
  SONG_CHOOSE: "song:choose",
  WORD_SUBMIT: "word:submit",
} as const;

/** Events emitted by the server. */
export const ServerEvents = {
  ROOM_UPDATED: "room:updated",
  BATTLE_STARTED: "battle:started",
  CHAT_MESSAGE: "chat:message",
  BATTLE_FINISHED: "battle:finished",
  WEBRTC_PEER_READY: "webrtc:peer-ready",
  WEBRTC_SIGNAL: "webrtc:signal",
  WORD_ROUND_STARTED: "word:round-started",
  WORD_ROUND_ENDED: "word:round-ended",
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

export interface RoleSelectPayload {
  roomCode: string;
  playerId: string;
  role: "dancer" | "spectator";
}

export interface BattleStartPayload {
  roomCode: string;
  requesterId: string;
  dancerIds?: [string, string];
}

export interface SongChallengeStartPayload {
  roomCode: string;
  requesterId: string;
}

export interface SongChallengeSubmitPayload {
  roomCode: string;
  playerId: string;
  text: string;
}

export interface SongChallengeSubmitResult {
  room: Room;
  /** accepted: won the right to choose; incorrect: misspelled; expired: sent after the countdown. */
  outcome: SubmitOutcome;
}

export interface SongChoosePayload {
  roomCode: string;
  playerId: string;
  songId: string;
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

/** A dancer's attempt at the word currently on screen. */
export interface WordSubmitPayload {
  roomCode: string;
  playerId: string;
  roundId: string;
  text: string;
}

export interface WordSubmitResult {
  /** won: first correct; late: correct but someone won first; incorrect: retry allowed; expired: too late. */
  outcome: SubmitWordOutcome;
  winnerId: string | null;
}

export interface WordRoundStartedPayload {
  roomCode: string;
  roundId: string;
  roundNumber: number;
  totalRounds: number;
  word: string;
  /** Time left in this round, computed by the server; clients never compare clocks. */
  expiresInMs: number;
}

export interface WordRoundEndedPayload {
  roomCode: string;
  roundId: string;
  roundNumber: number;
  totalRounds: number;
  word: string;
  winnerId: string | null;
  winnerName: string | null;
  reason: "won" | "expired";
  /** Rounds won so far per dancer. */
  wins: Record<string, number>;
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
  [ClientEvents.ROLE_SELECT]: (payload: RoleSelectPayload, ack?: Ack<Room>) => void;
  [ClientEvents.SONG_CHALLENGE_START]: (payload: SongChallengeStartPayload, ack?: Ack<Room>) => void;
  [ClientEvents.SONG_CHALLENGE_SUBMIT]: (
    payload: SongChallengeSubmitPayload,
    ack?: Ack<SongChallengeSubmitResult>,
  ) => void;
  [ClientEvents.SONG_CHOOSE]: (payload: SongChoosePayload, ack?: Ack<Room>) => void;
  [ClientEvents.WORD_SUBMIT]: (payload: WordSubmitPayload, ack?: Ack<WordSubmitResult>) => void;
}

export interface ServerToClientEvents {
  [ServerEvents.ROOM_UPDATED]: (room: Room) => void;
  [ServerEvents.BATTLE_STARTED]: (room: Room) => void;
  [ServerEvents.CHAT_MESSAGE]: (message: ChatMessage) => void;
  [ServerEvents.BATTLE_FINISHED]: (room: Room) => void;
  [ServerEvents.WEBRTC_PEER_READY]: (payload: WebRtcPeerReadyPayload) => void;
  [ServerEvents.WEBRTC_SIGNAL]: (payload: WebRtcSignalPayload) => void;
  [ServerEvents.WORD_ROUND_STARTED]: (payload: WordRoundStartedPayload) => void;
  [ServerEvents.WORD_ROUND_ENDED]: (payload: WordRoundEndedPayload) => void;
  [ServerEvents.ERROR]: (error: DomainErrorPayload) => void;
}

export interface SocketData {
  playerId?: string;
  roomCode?: string;
}
