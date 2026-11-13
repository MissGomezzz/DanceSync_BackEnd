import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { AuthError, type AuthIdentity, type TokenVerifier } from "../../src/application/auth/AuthIdentity.js";
import type { AuthAuditLog, AuthRejection } from "../../src/infrastructure/auth/authAudit.js";
import {
  entraRemoteKeys,
  GUEST_TOKEN_AUDIENCE,
  GUEST_TOKEN_ISSUER,
  JwtGuestTokenIssuer,
  JwtTokenVerifier,
} from "../../src/infrastructure/auth/JwtTokenVerifier.js";
import type { HandshakeAuthenticator } from "../../src/infrastructure/ws/handshakeAuth.js";

/**
 * Handshake authentication of the suites written before SEG-1, which exercise
 * rooms and battles, not authentication. Their sockets connect without a token
 * and name the player in room:join, so here (and only here, in test support)
 * the identity is whoever the first argument of room:join claims to be. The
 * production handlers never read an id from a payload: see seg1.*.test.ts,
 * which run against the real token validation.
 */
export const trustClaimedPlayerId: HandshakeAuthenticator = (socket, next) => {
  socket.data.auth = { kind: "user", playerId: `anonymous-${socket.id}` };
  socket.use(([event, payload], proceed) => {
    if (event === "room:join") {
      const claimed = (payload as { playerId?: unknown } | undefined)?.playerId;
      socket.data.auth = { kind: "user", playerId: claimed as string };
    }
    proceed();
  });
  next();
};

/**
 * Token validation of the same older suites for HTTP: "user:<id>" is a
 * registered user and "guest:<id>:<room>" a guest; anything else is refused.
 */
export const stubTokenVerifier: TokenVerifier = {
  async verify(token): Promise<AuthIdentity> {
    const [kind, playerId, roomCode] = token.split(":");
    if (kind === "user" && playerId) return { kind: "user", playerId };
    if (kind === "guest" && playerId && roomCode) return { kind: "guest", playerId, displayName: playerId, roomCode };
    throw new AuthError("UNAUTHORIZED", "malformed_token");
  },
};

/** Keeps every rejection so a test can assert what was (and was not) recorded. */
export class RecordingAudit implements AuthAuditLog {
  readonly entries: AuthRejection[] = [];

  rejected(entry: AuthRejection): void {
    this.entries.push(entry);
  }

  /** The recorded entries as they would be written to the log. */
  serialized(): string {
    return JSON.stringify(this.entries);
  }
}

export const silentAudit: AuthAuditLog = { rejected() {} };

export const TEST_TENANT_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_CLIENT_ID = "22222222-2222-4222-8222-222222222222";
export const TEST_ISSUER = `https://login.microsoftonline.com/${TEST_TENANT_ID}/v2.0`;
export const TEST_GUEST_SECRET = new TextEncoder().encode("test-guest-secret-of-at-least-32-bytes!!");

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

export interface EntraTokenOptions {
  oid?: string;
  /** Tenant that issues the token: sets `tid` and, unless `issuer` is given, the issuer. */
  tenantId?: string;
  name?: string;
  audience?: string;
  issuer?: string;
  /** Seconds from now; negative for an expired token. */
  expiresInSeconds?: number;
  /** Signs with another key (an attacker's) under the tenant's key id. */
  signingKey?: SigningKey;
}

/**
 * A stand-in for Microsoft Entra ID: an RSA key pair whose public half is
 * served as a JWKS over HTTP, exactly like the tenant's discovery keys
 * endpoint, and tokens signed with it. The verifier under test is the real one,
 * fetching the keys from this endpoint.
 */
export class FakeEntra {
  private server!: HttpServer;
  private privateKey!: SigningKey;
  private attackerKey!: SigningKey;
  private readonly keyId = "test-key-1";
  jwksUri = "";
  /** Times the key set was downloaded. */
  jwksRequests = 0;

  async start(): Promise<this> {
    const pair = await generateKeyPair("RS256");
    this.privateKey = pair.privateKey;
    this.attackerKey = (await generateKeyPair("RS256")).privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: this.keyId, use: "sig", alg: "RS256" };
    this.server = createServer((_req, res) => {
      this.jwksRequests += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => this.server.listen(0, resolve));
    this.jwksUri = `http://localhost:${(this.server.address() as AddressInfo).port}/discovery/v2.0/keys`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** The real verifier, trusting this tenant and the test guest secret. */
  /** The real verifier of a multi-tenant application: any tenant, personal accounts only if allowed. */
  multiTenantVerifier(allowPersonalAccounts: boolean): JwtTokenVerifier {
    return new JwtTokenVerifier({
      entra: { allowPersonalAccounts, audiences: [TEST_CLIENT_ID], keys: entraRemoteKeys(this.jwksUri) },
      guest: { secret: TEST_GUEST_SECRET },
    });
  }

  verifier(): JwtTokenVerifier {
    return new JwtTokenVerifier({
      entra: { issuer: TEST_ISSUER, audiences: [TEST_CLIENT_ID], keys: entraRemoteKeys(this.jwksUri) },
      guest: { secret: TEST_GUEST_SECRET },
    });
  }

  guestIssuer(ttlSeconds = 7_200): JwtGuestTokenIssuer {
    return new JwtGuestTokenIssuer(TEST_GUEST_SECRET, ttlSeconds);
  }

  /** An access token as Entra ID v2.0 issues it for the API. */
  token(options: EntraTokenOptions = {}): Promise<string> {
    const { oid = "user-ana", name = "Ana", audience = TEST_CLIENT_ID, tenantId = TEST_TENANT_ID, expiresInSeconds = 3600 } = options;
    const issuer = options.issuer ?? `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ oid, name, tid: tenantId, scp: "access_as_user", ver: "2.0" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: this.keyId })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(`sub-of-${oid}`)
      // Issued before it expires, also when the test asks for a token that is already too old.
      .setIssuedAt(Math.min(now - 60, now + expiresInSeconds - 3600))
      .setExpirationTime(now + expiresInSeconds)
      .sign(options.signingKey ?? this.privateKey);
  }

  /** A token with every claim right but signed by someone who is not the tenant. */
  forgedToken(options: EntraTokenOptions = {}): Promise<string> {
    return this.token({ ...options, signingKey: this.attackerKey });
  }
}

/** A valid token whose payload was edited afterwards (here: to become another user); the signature no longer matches. */
export function tamperedPayload(token: string, changes: Record<string, unknown>): string {
  const [header, payload, signature] = token.split(".");
  const claims = { ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), ...changes };
  return [header, Buffer.from(JSON.stringify(claims)).toString("base64url"), signature].join(".");
}

/** The same claims re-encoded as an unsigned token ("alg: none"). */
export function unsignedToken(token: string): string {
  const payload = token.split(".")[1];
  return `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${payload}.`;
}

/** A guest token signed with the test secret, for cases the issuer would never produce (expired, other audience). */
export function guestToken(options: {
  playerId?: string;
  displayName?: string;
  roomCode: string;
  expiresInSeconds?: number;
  audience?: string;
  secret?: Uint8Array;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (options.expiresInSeconds ?? 600);
  return new SignJWT({ name: options.displayName ?? "Guest", room: options.roomCode, scope: "guest" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(GUEST_TOKEN_ISSUER)
    .setAudience(options.audience ?? GUEST_TOKEN_AUDIENCE)
    .setSubject(options.playerId ?? "guest-test")
    .setIssuedAt(Math.min(now - 60, expiresAt - 600))
    .setExpirationTime(expiresAt)
    .sign(options.secret ?? TEST_GUEST_SECRET);
}
