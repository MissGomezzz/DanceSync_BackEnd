import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { CreateRoom } from "./application/usecases/CreateRoom.js";
import { IssueGuestToken } from "./application/usecases/IssueGuestToken.js";
import { FinishBattleAtDeadline } from "./application/usecases/FinishBattleAtDeadline.js";
import { JoinRoom } from "./application/usecases/JoinRoom.js";
import { KickPlayer } from "./application/usecases/KickPlayer.js";
import { ReapRooms } from "./application/usecases/ReapRooms.js";
import { CastVote } from "./application/usecases/CastVote.js";
import { RecordMatchResult } from "./application/usecases/RecordMatchResult.js";
import { StartRematch } from "./application/usecases/StartRematch.js";
import { SendChatMessage } from "./application/usecases/SendChatMessage.js";
import { StartBattle } from "./application/usecases/StartBattle.js";
import { env } from "./config/env.js";
import { consoleAuthAudit } from "./infrastructure/auth/authAudit.js";
import { entraRemoteKeys, JwtGuestTokenIssuer, JwtTokenVerifier } from "./infrastructure/auth/JwtTokenVerifier.js";
import { createHandshakeAuth } from "./infrastructure/ws/handshakeAuth.js";
import { HttpMatchResultPublisher } from "./infrastructure/http/HttpMatchResultPublisher.js";
import { buildRouter, createErrorHandler } from "./infrastructure/http/routes.js";
import { registerSocketHandlers, type BattleServer } from "./infrastructure/ws/socketHandlers.js";
import { SelectRole } from "./application/usecases/SelectRole.js";
import { AwardWordBonus } from "./application/usecases/AwardWordBonus.js";
import { SetReady } from "./application/usecases/SetReady.js";
import { ChooseSong } from "./application/usecases/ChooseSong.js";
import { StartSongChallenge } from "./application/usecases/StartSongChallenge.js";
import { SubmitSongPhrase } from "./application/usecases/SubmitSongPhrase.js";
import { StartWordRace } from "./application/usecases/StartWordRace.js";
import { OpenWordRound } from "./application/usecases/OpenWordRound.js";
import { ExpireWordRound } from "./application/usecases/ExpireWordRound.js";
import { StopWordRace } from "./application/usecases/StopWordRace.js";
import { ResumeWordRace } from "./application/usecases/ResumeWordRace.js";
import { SubmitWord } from "./application/usecases/SubmitWord.js";
import { GetActiveWordRound } from "./application/usecases/GetActiveWordRound.js";
import { createStateStores } from "./infrastructure/redis/stateStores.js";
import { loadAbuseConfig } from "./infrastructure/abuse/abuseConfig.js";
import { consoleAbuseAudit } from "./infrastructure/abuse/abuseAudit.js";
import { attachAbuseProtection } from "./infrastructure/abuse/abuseProtection.js";
import { WordRaceScheduler } from "./infrastructure/scheduling/WordRaceScheduler.js";
import { createSocketWordRaceBroadcaster } from "./infrastructure/ws/wordRaceMessages.js";
import { rootLogger as logger } from "./infrastructure/logging/logger.js";
import { createAccessLog } from "./infrastructure/http/accessLog.js";
import { PromMetrics } from "./infrastructure/metrics/PromMetrics.js";
import { startMetricsServer } from "./infrastructure/metrics/metricsServer.js";
import { countingAbuseAudit, countingAuthAudit } from "./infrastructure/metrics/countingAudits.js";
import { loadAuditConfig } from "./infrastructure/audit/auditConfig.js";
import { HttpAuditShipper } from "./infrastructure/audit/HttpAuditShipper.js";

// Wiring: adapters -> use cases -> entry points.
// REDIS_URL set: room and word race state in Redis (several instances). Not set: in memory, as before.
// OBS-1: Prometheus metrics, served on their own port (METRICS_PORT), never by the public app.
const metrics = new PromMetrics();
const stateStores = createStateStores(undefined, { logger, metrics });
const rooms = stateStores.rooms;
const wordRaces = stateStores.wordRaces;
const createRoom = new CreateRoom(rooms);
const joinRoom = new JoinRoom(rooms);
const battleTiming = {
  countdownMs: env.battleStartCountdownMs,
  fallbackDurationMs: env.wordRaceFallbackDurationMs,
  scoring: { votePoints: env.votePoints, wordBonusPoints: env.wordBonusPoints },
};
const startBattle = new StartBattle(rooms, battleTiming);
const sendChatMessage = new SendChatMessage(rooms);
const selectRole = new SelectRole(rooms);
const setReady = new SetReady(rooms);
const startSongChallenge = new StartSongChallenge(rooms, {
  durationMs: env.songChallengeMs,
  chooseMs: env.songChooseMs,
});
const submitSongPhrase = new SubmitSongPhrase(rooms);
const chooseSong = new ChooseSong(rooms, battleTiming);

// Authentication (SEG-1): Entra ID access tokens for registered users and
// guest tokens signed here. Whatever is not configured is refused, never skipped.
const guestSecret = env.auth.guest ? new TextEncoder().encode(env.auth.guest.secret) : null;
const tokenVerifier = new JwtTokenVerifier({
  ...(env.auth.entra
    ? {
        entra: {
          ...(env.auth.entra.issuer ? { issuer: env.auth.entra.issuer } : {}),
          allowPersonalAccounts: env.auth.entra.allowPersonalAccounts,
          audiences: [...env.auth.entra.audiences],
          keys: entraRemoteKeys(env.auth.entra.jwksUri),
        },
      }
    : {}),
  ...(guestSecret ? { guest: { secret: guestSecret } } : {}),
});
// The audit lines stay exactly as they are; each refusal is also counted.
const authAudit = countingAuthAudit(consoleAuthAudit, metrics);
if (!env.auth.entra) {
  logger.warn({}, "AZURE_TENANT_ID / AZURE_CLIENT_ID are not set: every registered-user token will be refused");
}
if (!env.auth.guest) {
  logger.warn({}, "GUEST_TOKEN_SECRET is not set: guest tokens are neither issued nor accepted");
}

// SEG-2, non-repudiation: every handshake and client event goes to the audit log of users-service,
// in batches, off the event path. Without AUDIT_INTERNAL_TOKEN the records wait in memory.
const abuseConfig = loadAbuseConfig();
const auditConfig = loadAuditConfig();
const auditTrail = new HttpAuditShipper(auditConfig, {
  logger,
  onResult: (result, count) => metrics.auditRecords(result, count),
});
if (auditConfig.enabled && !auditConfig.internalToken) {
  logger.warn({}, "AUDIT_INTERNAL_TOKEN is not set: audit records are kept in memory and not delivered");
}

const app = express();
// OBS-1: first, so every request (CORS preflights and errors included) gets its access line.
app.use(
  createAccessLog({
    logger,
    observe: ({ method, route, status, durationSeconds }) =>
      metrics.httpRequestHandled(method, route, status, durationSeconds),
  }),
);
app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json());

const httpServer = createServer(app);
const io: BattleServer = new Server(httpServer, {
  path: "/socket.io",
  cors: { origin: env.corsOrigin, credentials: true },
  // DIS-1: detect a dead connection (and so a dead replica) in seconds.
  pingInterval: env.socketPingIntervalMs,
  pingTimeout: env.socketPingTimeoutMs,
});
stateStores.attachAdapter(io);
const wordRaceScheduler = new WordRaceScheduler({
  startWordRace: new StartWordRace(rooms, wordRaces, {
    rounds: env.wordRaceRounds,
    windowMs: env.wordRaceWindowMs,
    minGapMs: env.wordRaceMinGapMs,
    fallbackDurationMs: env.wordRaceFallbackDurationMs,
  }),
  openWordRound: new OpenWordRound(rooms, wordRaces),
  expireWordRound: new ExpireWordRound(wordRaces),
  stopWordRace: new StopWordRace(wordRaces),
  resumeWordRace: new ResumeWordRace(rooms, wordRaces),
  broadcaster: createSocketWordRaceBroadcaster(io),
  logger,
  metrics,
});
const socketHandlers = registerSocketHandlers(io, {
  authenticateHandshake: createHandshakeAuth({
    verifier: tokenVerifier,
    audit: authAudit,
    logger,
    trail: auditTrail,
    trustedProxyHops: abuseConfig.trustedProxyHops,
  }),
  authAudit,
  joinRoom,
  startBattle,
  selectRole,
  setReady,
  sendChatMessage,
  castVote: new CastVote(rooms),
  startRematch: new StartRematch(rooms),
  startSongChallenge,
  submitSongPhrase,
  chooseSong,
  kickPlayer: new KickPlayer(rooms),
  finishBattleAtDeadline: new FinishBattleAtDeadline(rooms),
  // Finished battles go to users-service (PUT /api/matches/{battleId}), retried with backoff.
  // DIS-1: through a durable outbox that every replica's sweep drains, so no result is lost.
  recordMatchResult: new RecordMatchResult(new HttpMatchResultPublisher(env.usersServiceUrl), {
    outbox: stateStores.matchOutbox,
    logger,
  }),
  reapRooms: new ReapRooms(rooms),
  disconnectGraceMs: env.disconnectGraceMs,
  pagehideGraceMs: env.pagehideGraceMs,
  reaping: { sweepIntervalMs: env.roomSweepIntervalMs },
  wordRace: {
    scheduler: wordRaceScheduler,
    submitWord: new SubmitWord(wordRaces),
    awardWordBonus: new AwardWordBonus(rooms),
    getActiveWordRound: new GetActiveWordRound(wordRaces),
  },
  logger,
  metrics,
  sessions: stateStores.sessions,
  auditTrail,
  trustedProxyHops: abuseConfig.trustedProxyHops,
});
// SEG-3: after the handshake authentication, so the block check knows who connects.
// Every event goes through a token bucket before any handler; clients that keep
// flooding are blocked (shared through Redis when REDIS_URL is set) and disconnected.
attachAbuseProtection(io, {
  config: abuseConfig,
  blocks: stateStores.blocks,
  audit: countingAbuseAudit(consoleAbuseAudit, metrics),
  logger,
  trail: auditTrail,
});

// HTTP routes go after the socket handlers so a created room can be watched:
// if its host never connects, the room is reaped instead of living forever.
app.use(
  buildRouter({
    auth: { verifier: tokenVerifier, audit: authAudit },
    ...(guestSecret && env.auth.guest
      ? { issueGuestToken: new IssueGuestToken(rooms, new JwtGuestTokenIssuer(guestSecret, env.auth.guest.ttlSeconds)) }
      : {}),
    createRoom,
    rooms,
    onRoomCreated: (room) => socketHandlers.watchNewRoom(room.code, room.hostId),
    leaveRoom: (roomCode, playerId) => socketHandlers.leave(roomCode, playerId),
    leaveAfterPagehide: (roomCode, playerId) => socketHandlers.leaveAfterPagehide(roomCode, playerId),
    readiness: () => stateStores.ping(),
    logger,
    metrics,
  }),
);
app.use(createErrorHandler(logger, metrics));

httpServer.listen(env.port, () => {
  logger.info({ port: env.port, corsOrigin: env.corsOrigin }, "battle-service listening");
});
const metricsServer = startMetricsServer(metrics.registry, env.metricsPort, logger).then(
  (server) => {
    logger.info({ port: env.metricsPort, path: "/metrics" }, "Metrics endpoint listening");
    return server;
  },
  (error: unknown) => {
    // Metrics are not worth stopping the battles for: log it and keep serving.
    logger.error({ port: env.metricsPort, err: error }, "Could not start the metrics endpoint");
    return null;
  },
);

function shutdown(signal: string): void {
  logger.info({ signal }, "Shutting down battle-service");
  socketHandlers.close();
  // Only this replica's timers: the races stay in the store for the other replicas.
  wordRaceScheduler.close();
  io.close();
  void metricsServer.then((server) => server?.close());
  httpServer.close(() => {
    // SEG-2: deliver the last audit records before the replica goes away.
    void auditTrail
      .close()
      .then(() => stateStores.close())
      .finally(() => process.exit(0));
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Safety net: every handler and timer catches its own errors. If a rejected
// promise ever slips through, log it instead of letting Node stop the process
// (rooms live in memory, so a crash ends every battle in progress). A synchronous
// uncaught exception may leave state half-updated, so that one is logged and the
// process exits as Node recommends, to be restarted by its supervisor.
process.on("unhandledRejection", (reason) => {
  metrics.error("process");
  logger.error({ err: reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (error, origin) => {
  logger.error({ origin, err: error }, "Uncaught exception, exiting");
  process.exit(1);
});
