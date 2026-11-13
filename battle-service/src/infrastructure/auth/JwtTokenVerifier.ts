import { createRemoteJWKSet, decodeJwt, errors, jwtVerify, SignJWT, type JWTPayload, type JWTVerifyGetKey } from "jose";
import {
  AuthError,
  type AuthFailureReason,
  type AuthIdentity,
  type GuestTokenClaims,
  type GuestTokenIssuer,
  type IssuedGuestToken,
  type TokenVerifier,
} from "../../application/auth/AuthIdentity.js";
import { MAX_DISPLAY_NAME_LENGTH, MAX_PLAYER_ID_LENGTH } from "../../domain/model/Player.js";

/** Issuer and audience of the guest tokens; the api-gateway validates the same values. */
export const GUEST_TOKEN_ISSUER = "dancesync-battle-service";
export const GUEST_TOKEN_AUDIENCE = "dancesync-guest";
/** Smallest accepted HS256 secret (RFC 7518: at least as long as the hash output). */
export const MIN_GUEST_SECRET_BYTES = 32;

/** Accepted difference between this clock and the issuer's, like Spring Security's default. */
const CLOCK_TOLERANCE_SECONDS = 60;

export interface EntraVerifierConfig {
  /** `https://login.microsoftonline.com/{tenant}/v2.0` */
  issuer: string;
  /** Accepted `aud` values: the API's application (client) id and/or its App ID URI. */
  audiences: string[];
  /** Signing keys of the tenant: a remote JWKS in production, a local set in tests. */
  keys: JWTVerifyGetKey;
}

export interface GuestVerifierConfig {
  secret: Uint8Array;
}

export interface JwtTokenVerifierConfig {
  /** Absent: Entra ID is not configured and every registered-user token is refused. */
  entra?: EntraVerifierConfig;
  /** Absent: guest tokens are not configured and every guest token is refused. */
  guest?: GuestVerifierConfig;
}

/** The Entra ID signing keys, fetched lazily and cached (rotated keys are picked up on a miss). */
export function entraRemoteKeys(jwksUri: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUri), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
}

/**
 * Validates the two kinds of token this service accepts, chosen by issuer:
 * access tokens issued by Microsoft Entra ID (RS256, keys from the tenant's
 * JWKS) and guest tokens signed by this service (HS256). Signature, expiry,
 * issuer and audience are always checked, and only the expected algorithm of
 * each issuer is allowed (so "alg: none" or an HS256 token forged with the
 * public key are refused).
 */
export class JwtTokenVerifier implements TokenVerifier {
  constructor(private readonly config: JwtTokenVerifierConfig) {}

  async verify(token: string): Promise<AuthIdentity> {
    const issuer = unverifiedIssuer(token);
    try {
      if (issuer === GUEST_TOKEN_ISSUER && this.config.guest) return await this.verifyGuest(token, this.config.guest);
      if (this.config.entra && issuer === this.config.entra.issuer) return await this.verifyEntra(token, this.config.entra);
    } catch (error) {
      throw toAuthError(error);
    }
    throw new AuthError("UNAUTHORIZED", "wrong_issuer");
  }

  private async verifyEntra(token: string, entra: EntraVerifierConfig): Promise<AuthIdentity> {
    const { payload } = await jwtVerify(token, entra.keys, {
      issuer: entra.issuer,
      audience: entra.audiences,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp"],
    });
    // `oid` identifies the user across every application of the tenant; `sub` is per application.
    const playerId = stringClaim(payload, "oid") ?? stringClaim(payload, "sub");
    if (!playerId || playerId.length > MAX_PLAYER_ID_LENGTH) throw new AuthError("UNAUTHORIZED", "invalid_claims");
    const name = (stringClaim(payload, "name") ?? stringClaim(payload, "preferred_username"))?.trim();
    return { kind: "user", playerId, ...(name ? { displayName: name.slice(0, MAX_DISPLAY_NAME_LENGTH) } : {}) };
  }

  private async verifyGuest(token: string, guest: GuestVerifierConfig): Promise<AuthIdentity> {
    const { payload } = await jwtVerify(token, guest.secret, {
      issuer: GUEST_TOKEN_ISSUER,
      audience: GUEST_TOKEN_AUDIENCE,
      algorithms: ["HS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp", "sub"],
    });
    const playerId = stringClaim(payload, "sub");
    const displayName = stringClaim(payload, "name");
    const roomCode = stringClaim(payload, "room");
    if (!playerId || !displayName || !roomCode || payload.scope !== "guest") {
      throw new AuthError("UNAUTHORIZED", "invalid_claims");
    }
    return { kind: "guest", playerId, displayName, roomCode };
  }
}

/** Signs guest tokens: HS256, short-lived, bound to one room through the `room` claim. */
export class JwtGuestTokenIssuer implements GuestTokenIssuer {
  constructor(
    private readonly secret: Uint8Array,
    private readonly ttlSeconds: number,
  ) {}

  async issue(claims: GuestTokenClaims, now: Date): Promise<IssuedGuestToken> {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = issuedAt + this.ttlSeconds;
    const token = await new SignJWT({ name: claims.displayName, room: claims.roomCode, scope: "guest" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(GUEST_TOKEN_ISSUER)
      .setAudience(GUEST_TOKEN_AUDIENCE)
      .setSubject(claims.playerId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.secret);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }
}

/** The `iss` claim before any validation, only used to pick which keys must validate the token. */
function unverifiedIssuer(token: string): string | undefined {
  try {
    return decodeJwt(token).iss;
  } catch {
    throw new AuthError("UNAUTHORIZED", "malformed_token");
  }
}

function stringClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  return new AuthError("UNAUTHORIZED", failureReason(error));
}

function failureReason(error: unknown): AuthFailureReason {
  if (error instanceof errors.JWTExpired) return "expired_token";
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "aud") return "wrong_audience";
    if (error.claim === "iss") return "wrong_issuer";
    return "invalid_claims";
  }
  // A key id the tenant never published is as good as a bad signature.
  if (error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JWKSNoMatchingKey) {
    return "invalid_signature";
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return "invalid_signature";
  if (error instanceof errors.JOSEError) {
    return error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid ? "verifier_unavailable" : "malformed_token";
  }
  // Anything else is a failure reaching the key set (network): fail closed.
  return "verifier_unavailable";
}
