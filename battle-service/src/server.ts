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

// Wiring: adapters -> use cases -> entry points.
const rooms = new InMemoryRoomRepository();
const createRoom = new CreateRoom(rooms);
const joinRoom = new JoinRoom(rooms);
const startBattle = new StartBattle(rooms);
const sendChatMessage = new SendChatMessage(rooms);
const rateDancer = new RateDancer(rooms);

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
registerSocketHandlers(io, { joinRoom, startBattle, sendChatMessage, rateDancer });

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
