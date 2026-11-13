import "dotenv/config";

/**
 * Every numeric setting is validated once, at startup: a typo such as
 * BATTLE_START_COUNTDOWN_MS=abc or a negative duration stops the process with a
 * clear message instead of silently producing an Invalid Date or a timer that
 * fires immediately.
 */
type NumberRule = "non-negative" | "positive" | "non-negative-integer" | "positive-integer";

type Source = Record<string, string | undefined>;

function readNumber(source: Source, name: string, fallback: number, rule: NumberRule): number {
  const raw = source[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, received "${raw}"`);
  }
  const integer = rule === "non-negative-integer" || rule === "positive-integer";
  const positive = rule === "positive" || rule === "positive-integer";
  if (integer && !Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be a whole number, received "${raw}"`);
  }
  if (positive ? parsed <= 0 : parsed < 0) {
    throw new Error(`Environment variable ${name} must be ${positive ? "greater than 0" : "0 or more"}, received "${raw}"`);
  }
  return parsed;
}

/** Smallest accepted GUEST_TOKEN_SECRET: 32 bytes, the size of the HS256 hash. */
const MIN_GUEST_SECRET_LENGTH = 32;

function readText(source: Source, name: string): string {
  return source[name]?.trim() ?? "";
}

/**
 * Authentication settings (SEG-1). Both token kinds fail closed: without the
 * Entra ID settings every registered-user token is refused, and without the
 * guest secret no guest token is issued or accepted. A secret that is too short
 * is a configuration error and stops the process.
 */
function readAuth(source: Source, read: (name: string, fallback: number, rule: NumberRule) => number) {
  const tenantId = readText(source, "AZURE_TENANT_ID");
  const clientId = readText(source, "AZURE_CLIENT_ID");
  const audiences = (readText(source, "AZURE_API_AUDIENCE") || clientId)
    .split(",")
    .map((audience) => audience.trim())
    .filter((audience) => audience.length > 0);
  const authority = tenantId ? `https://login.microsoftonline.com/${tenantId}` : "";
  // Overridable so tests (and sovereign clouds) can point at another issuer and key set.
  const issuer = readText(source, "ENTRA_ISSUER_URI") || (authority && `${authority}/v2.0`);
  const jwksUri = readText(source, "ENTRA_JWKS_URI") || (authority && `${authority}/discovery/v2.0/keys`);
  const secret = source.GUEST_TOKEN_SECRET ?? "";
  if (secret.length > 0 && Buffer.byteLength(secret, "utf8") < MIN_GUEST_SECRET_LENGTH) {
    throw new Error(`Environment variable GUEST_TOKEN_SECRET must be at least ${MIN_GUEST_SECRET_LENGTH} bytes long`);
  }
  return {
    /** Null until AZURE_TENANT_ID and AZURE_CLIENT_ID are set. */
    entra: issuer && jwksUri && audiences.length > 0 ? { issuer, jwksUri, audiences } : null,
    /** Null until GUEST_TOKEN_SECRET is set (the same value as in the api-gateway). */
    guest:
      secret.length > 0
        ? { secret, ttlSeconds: read("GUEST_TOKEN_TTL_SECONDS", 7_200, "positive-integer") }
        : null,
  } as const;
}

/** Reads and validates the configuration; throws on the first invalid value. */
export function loadEnv(source: Source = process.env) {
  const read = (name: string, fallback: number, rule: NumberRule) => readNumber(source, name, fallback, rule);
  return {
    port: read("PORT", 3000, "non-negative-integer"),
    corsOrigin: source.CORS_ORIGIN ?? "http://localhost:5173",
    usersServiceUrl: source.USERS_SERVICE_URL ?? "http://localhost:8081",
    /**
     * How long a disconnected player keeps their seat before being removed.
     * Covers page refreshes and transient network drops without closing the room.
     */
    disconnectGraceMs: read("DISCONNECT_GRACE_MS", 15_000, "non-negative"),
    /**
     * How long a seat is kept after a "pagehide" leave beacon (POST
     * /api/rooms/:code/leave). Browsers send it on a reload too, so the seat is
     * released only if the player has not rejoined by then.
     */
    pagehideGraceMs: read("PAGEHIDE_GRACE_MS", 3_000, "non-negative"),
    /** Time players have to type the phrase that grants the right to choose the song. */
    songChallengeMs: read("SONG_CHALLENGE_MS", 15_000, "positive"),
    /** Time the chooser has to pick a song before the server picks one at random. */
    songChooseMs: read("SONG_CHOOSE_MS", 20_000, "positive"),
    /** Countdown between the battle start and the moment dancing (and voting) begins. */
    battleStartCountdownMs: read("BATTLE_START_COUNTDOWN_MS", 5_000, "non-negative"),
    /** Word race rounds per battle (fewer when the song is too short to fit them). */
    wordRaceRounds: read("WORD_RACE_ROUNDS", 3, "non-negative-integer"),
    /** Time dancers have to type each word-race word. */
    wordRaceWindowMs: read("WORD_RACE_WINDOW_MS", 10_000, "positive"),
    /** Minimum time between two word-race round openings. */
    wordRaceMinGapMs: read("WORD_RACE_MIN_GAP_MS", 12_000, "non-negative"),
    /** Points a spectator's vote is worth: score = VOTE_POINTS x votes + WORD_BONUS_POINTS x wordsWon. */
    votePoints: read("VOTE_POINTS", 2, "positive-integer"),
    /** Points a dancer earns for each word round won, added to the battle score. */
    wordBonusPoints: read("WORD_BONUS_POINTS", 1, "positive-integer"),
    /**
     * Song length assumed when the battle has no song: for the word-race timeline
     * and for the moment the battle finishes on its own.
     */
    wordRaceFallbackDurationMs: read("WORD_RACE_FALLBACK_DURATION_MS", 90_000, "positive"),
    /** Token validation: Microsoft Entra ID for registered users, a shared secret for guests. */
    auth: readAuth(source, read),
  } as const;
}

export const env = loadEnv();

export type Env = ReturnType<typeof loadEnv>;
