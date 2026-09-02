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
} as const;

export type Env = typeof env;
