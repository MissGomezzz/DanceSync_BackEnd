import "dotenv/config";

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, received "${raw}"`);
  }
  return parsed;
}

export const env = {
  port: readNumber("PORT", 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  usersServiceUrl: process.env.USERS_SERVICE_URL ?? "http://localhost:8081",
  /**
   * How long a disconnected player keeps their seat before being removed.
   * Covers page refreshes and transient network drops without closing the room.
   */
  disconnectGraceMs: readNumber("DISCONNECT_GRACE_MS", 15_000),
  /** Time players have to type the phrase that grants the right to choose the song. */
  songChallengeMs: readNumber("SONG_CHALLENGE_MS", 15_000),
} as const;

export type Env = typeof env;
