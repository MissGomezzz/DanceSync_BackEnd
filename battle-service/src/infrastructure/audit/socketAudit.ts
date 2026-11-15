import type { Socket } from "socket.io";
import type { AuditEntry } from "../../application/ports/AuditTrail.js";
import { clientAddress } from "../abuse/clientAddress.js";
import { ClientEvents } from "../ws/events.js";

/** Who is behind a connection and from where, for its audit records (SEG-2). */
export type SocketActor = Pick<AuditEntry, "userId" | "userKind" | "userName" | "ip" | "userAgent" | "correlationId">;

type AnySocket = Pick<Socket, "handshake" | "data">;

/**
 * The identity proven by the handshake token (none before it is validated), the client's address
 * behind `trustedProxyHops` trusted proxies (shared with SEG-3 through `socket.data.clientIp`), the
 * browser and the correlation id of the handshake.
 */
export function socketActor(socket: AnySocket, trustedProxyHops: number): SocketActor {
  if (typeof socket.data.clientIp !== "string") {
    socket.data.clientIp = clientAddress(socket.handshake.address, socket.handshake.headers["x-forwarded-for"], trustedProxyHops);
  }
  const auth = socket.data.auth as { kind: "user" | "guest"; playerId: string; displayName?: string } | undefined;
  const userAgent = socket.handshake.headers["user-agent"];
  return {
    userId: auth?.playerId,
    userKind: auth?.kind ?? "anonymous",
    userName: auth?.displayName,
    ip: socket.data.clientIp as string,
    userAgent: typeof userAgent === "string" ? userAgent : undefined,
    correlationId: socket.data.correlationId as string | undefined,
  };
}

const MAX_WORD = 40;

/**
 * The facts about an event worth keeping as evidence of what the player did: whom the vote was for,
 * whom the host kicked, which role or song was chosen, the word typed in a word race. Only known
 * fields of known events; the chat text is never stored (only its length), and WebRTC payloads
 * (network addresses of the peers) are left out.
 */
export function auditDetail(event: string, payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value.slice(0, 64) : undefined);
  switch (event) {
    case ClientEvents.VOTE_CAST:
      return p.dancerId === null ? "dancerId=none" : fact("dancerId", text(p.dancerId));
    case ClientEvents.PLAYER_KICK:
      return fact("playerId", text(p.playerId));
    case ClientEvents.ROLE_SELECT:
      return fact("role", text(p.role));
    case ClientEvents.PLAYER_READY:
      return typeof p.ready === "boolean" ? `ready=${p.ready}` : undefined;
    case ClientEvents.SONG_CHOOSE:
      return fact("songId", text(p.songId));
    case ClientEvents.WORD_SUBMIT:
      return [fact("roundId", text(p.roundId)), fact("word", typeof p.text === "string" ? p.text.slice(0, MAX_WORD) : undefined)]
        .filter(Boolean)
        .join(" ") || undefined;
    case ClientEvents.CHAT_MESSAGE:
      return typeof p.content === "string" ? `length=${p.content.length}` : undefined;
    case ClientEvents.BATTLE_START:
      return Array.isArray(p.dancerIds) ? `dancerIds=${p.dancerIds.filter((id) => typeof id === "string").join(",").slice(0, 200)}` : undefined;
    case ClientEvents.WEBRTC_SIGNAL:
      return fact("to", text(p.to));
    default:
      return undefined;
  }
}

function fact(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${name}=${value}`;
}
