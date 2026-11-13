/**
 * Who is acting, as proven by a validated token (SEG-1). The player id always
 * comes from here, never from an identifier sent by the client.
 */
export type AuthIdentity = RegisteredIdentity | GuestIdentity;

/** A user signed in with Microsoft Entra ID; `playerId` is the token's object id (`oid`). */
export interface RegisteredIdentity {
  kind: "user";
  playerId: string;
  /** The account's name, used when the client does not choose a display name. */
  displayName?: string;
}

/** A guest holding a short-lived token signed by this service, valid only for `roomCode`. */
export interface GuestIdentity {
  kind: "guest";
  playerId: string;
  displayName: string;
  roomCode: string;
}

/** Why a token (or the action attempted with it) was refused. Logged, never sent to the client. */
export type AuthFailureReason =
  | "missing_token"
  | "malformed_token"
  | "invalid_signature"
  | "expired_token"
  | "wrong_issuer"
  | "wrong_audience"
  | "invalid_claims"
  | "guest_out_of_scope"
  | "verifier_unavailable";

export type AuthErrorCode = "UNAUTHORIZED" | "FORBIDDEN";

/**
 * UNAUTHORIZED: there is no valid token. FORBIDDEN: the token is valid but does
 * not allow the action (a guest outside their room or doing a registered-only action).
 */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly reason: AuthFailureReason,
    message: string = code === "UNAUTHORIZED" ? "A valid access token is required" : "This token does not allow this action",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Port: validates a token (signature, expiry, issuer, audience) and returns who it identifies. */
export interface TokenVerifier {
  /** Throws AuthError("UNAUTHORIZED") when the token is not valid. */
  verify(token: string): Promise<AuthIdentity>;
}

export interface GuestTokenClaims {
  playerId: string;
  displayName: string;
  roomCode: string;
}

export interface IssuedGuestToken {
  token: string;
  expiresAt: Date;
}

/** Port: signs the guest token. */
export interface GuestTokenIssuer {
  issue(claims: GuestTokenClaims, now: Date): Promise<IssuedGuestToken>;
}

/** True when `identity` may act in `roomCode`: registered users anywhere, guests only in their room. */
export function mayActInRoom(identity: AuthIdentity, roomCode: string): boolean {
  return identity.kind === "user" || identity.roomCode.toUpperCase() === roomCode.trim().toUpperCase();
}
