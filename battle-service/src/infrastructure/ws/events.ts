import type { ChatMessage } from "../../domain/model/ChatMessage.js";
import type { RoomDto } from "../serialization/roomDto.js";
import type { SubmitWordOutcome } from "../../domain/model/WordRace.js";
import type { SubmitOutcome } from "../../domain/services/SongSelectionService.js";

/** Events emitted by clients. */
export const ClientEvents = {
  ROOM_JOIN: "room:join",
  ROOM_LEAVE: "room:leave",
  BATTLE_START: "battle:start",
  CHAT_MESSAGE: "chat:message",
  VOTE_CAST: "vote:cast",
  ROOM_REMATCH: "room:rematch",
  WEBRTC_READY: "webrtc:ready",
  WEBRTC_SIGNAL: "webrtc:signal",
  ROLE_SELECT: "role:select",
  PLAYER_READY: "player:ready",
  SONG_CHALLENGE_START: "song-challenge:start",
  SONG_CHALLENGE_SUBMIT: "song-challenge:submit",
  SONG_CHOOSE: "song:choose",
  WORD_SUBMIT: "word:submit",
  PLAYER_KICK: "player:kick",
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
  ROOM_KICKED: "room:kicked",
  VOTE_MINE: "vote:mine",
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

/** Marks the player as ready (true) or not ready (false) while the room is waiting. */
export interface PlayerReadyPayload {
  roomCode: string;
  playerId: string;
  ready: boolean;
}

/** The host removes `playerId` from the lobby. */
export interface PlayerKickPayload {
  roomCode: string;
  requesterId: string;
  playerId: string;
}

/** Sent only to the sockets of the kicked player, right before they are unbound from the room. */
export interface RoomKickedPayload {
  roomCode: string;
}

export interface BattleStartPayload {
  roomCode: string;
  requesterId: string;
  /** Overrides the dancers chosen through role:select; at least MIN_DANCERS_PER_BATTLE ids. */
  dancerIds?: string[];
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
  room: RoomDto;
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

/** A spectator casts or moves their vote (dancerId) or withdraws it (null). */
export interface VoteCastPayload {
  roomCode: string;
  voterId: string;
  dancerId: string | null;
}

/** Ack of vote:cast: the voter's current vote. New totals arrive through room:updated. */
export interface VoteCastResult {
  dancerId: string | null;
}

/**
 * The receiving spectator's own current vote. Sent only to their player channel,
 * after each change (including a vote discarded because its dancer left, or
 * cleared by a rematch) and when they (re)join a room with a battle.
 */
export interface VoteMinePayload {
  roomCode: string;
  dancerId: string | null;
}

/** The host takes a finished room back to the lobby. */
export interface RoomRematchPayload {
  roomCode: string;
  requesterId: string;
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
  /** Points the winner earned for this round (WORD_BONUS_POINTS); 0 when nobody won it. */
  bonusPoints: number;
}

export interface DomainErrorPayload {
  code: string;
  message: string;
}

/** Acknowledgement callback shape shared by every client event. */
export type Ack<T> = (response: { ok: true; data: T } | { ok: false; error: DomainErrorPayload }) => void;

export interface ClientToServerEvents {
  [ClientEvents.ROOM_JOIN]: (payload: RoomJoinPayload, ack?: Ack<RoomDto>) => void;
  [ClientEvents.ROOM_LEAVE]: (payload: RoomLeavePayload, ack?: Ack<RoomDto | null>) => void;
  [ClientEvents.BATTLE_START]: (payload: BattleStartPayload, ack?: Ack<RoomDto>) => void;
  [ClientEvents.CHAT_MESSAGE]: (payload: ChatMessagePayload, ack?: Ack<ChatMessage>) => void;
  [ClientEvents.VOTE_CAST]: (payload: VoteCastPayload, ack?: Ack<VoteCastResult>) => void;
  [ClientEvents.ROOM_REMATCH]: (payload: RoomRematchPayload, ack?: Ack<RoomDto>) => void;
  [ClientEvents.WEBRTC_READY]: (payload: WebRtcReadyPayload, ack?: Ack<null>) => void;
  [ClientEvents.WEBRTC_SIGNAL]: (payload: WebRtcSignalPayload, ack?: Ack<null>) => void;
  [ClientEvents.ROLE_SELECT]: (payload: RoleSelectPayload, ack?: Ack<RoomDto>) => void;
  [ClientEvents.PLAYER_READY]: (payload: PlayerReadyPayload, ack?: Ack<RoomDto>) => void;
  [ClientEvents.SONG_CHALLENGE_START]: (payload: SongChallengeStartPayload, ack?: Ack<RoomDto>) => void;
  [ClientEvents.SONG_CHALLENGE_SUBMIT]: (
    payload: SongChallengeSubmitPayload,
    ack?: Ack<SongChallengeSubmitResult>,
  ) => void;
  [ClientEvents.SONG_CHOOSE]: (payload: SongChoosePayload, ack?: Ack<RoomDto>) => void;
  [ClientEvents.WORD_SUBMIT]: (payload: WordSubmitPayload, ack?: Ack<WordSubmitResult>) => void;
  [ClientEvents.PLAYER_KICK]: (payload: PlayerKickPayload, ack?: Ack<RoomDto>) => void;
}

export interface ServerToClientEvents {
  [ServerEvents.ROOM_UPDATED]: (room: RoomDto) => void;
  [ServerEvents.BATTLE_STARTED]: (room: RoomDto) => void;
  [ServerEvents.CHAT_MESSAGE]: (message: ChatMessage) => void;
  [ServerEvents.BATTLE_FINISHED]: (room: RoomDto) => void;
  [ServerEvents.WEBRTC_PEER_READY]: (payload: WebRtcPeerReadyPayload) => void;
  [ServerEvents.WEBRTC_SIGNAL]: (payload: WebRtcSignalPayload) => void;
  [ServerEvents.WORD_ROUND_STARTED]: (payload: WordRoundStartedPayload) => void;
  [ServerEvents.WORD_ROUND_ENDED]: (payload: WordRoundEndedPayload) => void;
  [ServerEvents.ROOM_KICKED]: (payload: RoomKickedPayload) => void;
  [ServerEvents.VOTE_MINE]: (payload: VoteMinePayload) => void;
  [ServerEvents.ERROR]: (error: DomainErrorPayload) => void;
}

export interface SocketData {
  playerId?: string;
  roomCode?: string;
}
