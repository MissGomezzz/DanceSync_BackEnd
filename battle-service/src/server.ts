import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { CreateRoom } from "./application/usecases/CreateRoom.js";
import { JoinRoom } from "./application/usecases/JoinRoom.js";
import { RateDancer } from "./application/usecases/RateDancer.js";
import { SendChatMessage } from "./application/usecases/SendChatMessage.js";
import { StartBattle } from "./application/usecases/StartBattle.js";
import { env } from "./config/env.js";
import { buildRouter, errorHandler } from "./infrastructure/http/routes.js";
import { InMemoryRoomRepository } from "./infrastructure/persistence/InMemoryRoomRepository.js";
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
import { SubmitWord } from "./application/usecases/SubmitWord.js";
import { GetActiveWordRound } from "./application/usecases/GetActiveWordRound.js";
import { InMemoryWordRaceRepository } from "./infrastructure/persistence/InMemoryWordRaceRepository.js";
import { WordRaceScheduler } from "./infrastructure/scheduling/WordRaceScheduler.js";
import { createSocketWordRaceBroadcaster } from "./infrastructure/ws/wordRaceMessages.js";

// Wiring: adapters -> use cases -> entry points.
const rooms = new InMemoryRoomRepository();
const wordRaces = new InMemoryWordRaceRepository();
const createRoom = new CreateRoom(rooms);
const joinRoom = new JoinRoom(rooms);
const startBattle = new StartBattle(rooms);
const sendChatMessage = new SendChatMessage(rooms);
const rateDancer = new RateDancer(rooms);
const selectRole = new SelectRole(rooms);
const setReady = new SetReady(rooms);
const startSongChallenge = new StartSongChallenge(rooms, { durationMs: env.songChallengeMs });
const submitSongPhrase = new SubmitSongPhrase(rooms);
const chooseSong = new ChooseSong(rooms);

const app = express();
app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json());
app.use(buildRouter({ createRoom, rooms }));
app.use(errorHandler);

const httpServer = createServer(app);
const io: BattleServer = new Server(httpServer, {
  path: "/socket.io",
  cors: { origin: env.corsOrigin, credentials: true },
});
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
  broadcaster: createSocketWordRaceBroadcaster(io),
});
registerSocketHandlers(io, {
  joinRoom,
  startBattle,
  selectRole,
  setReady,
  sendChatMessage,
  rateDancer,
  startSongChallenge,
  submitSongPhrase,
  chooseSong,
  disconnectGraceMs: env.disconnectGraceMs,
  wordRace: {
    scheduler: wordRaceScheduler,
    submitWord: new SubmitWord(wordRaces),
    awardWordBonus: new AwardWordBonus(rooms, env.wordBonusPoints),
    getActiveWordRound: new GetActiveWordRound(wordRaces),
  },
});

httpServer.listen(env.port, () => {
  console.log(`battle-service listening on http://localhost:${env.port} (CORS origin: ${env.corsOrigin})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down battle-service`);
  io.close();
  httpServer.close(() => process.exit(0));
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
