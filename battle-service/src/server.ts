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
import { buildRouter, errorHandler } from "./infrastructure/http/routes.js";
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

// Wiring: adapters -> use cases -> entry points.
// REDIS_URL set: room and word race state in Redis (several instances). Not set: in memory, as before.
const stateStores = createStateStores();
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
const authAudit = consoleAuthAudit;
if (!env.auth.entra) {
  console.warn("AZURE_TENANT_ID / AZURE_CLIENT_ID are not set: every registered-user token will be refused");
}
if (!env.auth.guest) {
  console.warn("GUEST_TOKEN_SECRET is not set: guest tokens are neither issued nor accepted");
}

const app = express();
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
});
const socketHandlers = registerSocketHandlers(io, {
  authenticateHandshake: createHandshakeAuth({ verifier: tokenVerifier, audit: authAudit }),
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
});
// SEG-3: after the handshake authentication, so the block check knows who connects.
// Every event goes through a token bucket before any handler; clients that keep
// flooding are blocked (shared through Redis when REDIS_URL is set) and disconnected.
attachAbuseProtection(io, { config: loadAbuseConfig(), blocks: stateStores.blocks, audit: consoleAbuseAudit });

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
  }),
);
app.use(errorHandler);

httpServer.listen(env.port, () => {
  console.log(`battle-service listening on http://localhost:${env.port} (CORS origin: ${env.corsOrigin})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down battle-service`);
  socketHandlers.close();
  // Only this replica's timers: the races stay in the store for the other replicas.
  wordRaceScheduler.close();
  io.close();
  httpServer.close(() => {
    void stateStores.close().finally(() => process.exit(0));
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
  console.error("Unhandled promise rejection", reason);
});
process.on("uncaughtException", (error, origin) => {
  console.error(`Uncaught exception (${origin}), exiting`, error);
  process.exit(1);
});
