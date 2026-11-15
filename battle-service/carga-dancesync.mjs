// carga-dancesync.mjs
// Simula salas de DanceSync (maximo 7 jugadores por sala) contra el gateway:
// crea la sala por HTTP, conecta cada jugador por Socket.IO, hace room:join y
// manda mensajes de chat de vez en cuando. Mide conexiones, latencia y caidas.
//
// Uso (CMD de Windows), desde la carpeta battle-service (ya trae socket.io-client):
//   set BASE=https://TU-GATEWAY.azurecontainerapps.io
//   set USERS=40
//   node carga-dancesync.mjs
//
// Variables opcionales: ROOM_SIZE (7), RAMP (20 s para entrar), HOLD (60 s conectados),
// CHAT_EVERY (8 s), TRANSPORTS ("polling,websocket"; usa "websocket" para solo WebSocket).

import { io } from "socket.io-client";

const BASE = (process.env.BASE ?? "http://localhost:8080").replace(/\/$/, "");
const USERS = Number(process.env.USERS ?? 40);
const ROOM_SIZE = Math.min(Number(process.env.ROOM_SIZE ?? 7), 7);
const RAMP_S = Number(process.env.RAMP ?? 20);
const HOLD_S = Number(process.env.HOLD ?? 60);
const CHAT_EVERY_S = Number(process.env.CHAT_EVERY ?? 8);
const TRANSPORTS = (process.env.TRANSPORTS ?? "polling,websocket").split(",");

const runId = Math.random().toString(36).slice(2, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = {
  rooms: 0,
  roomsFail: 0,
  connected: 0,
  connectFail: 0,
  joined: 0,
  joinFail: 0,
  chatOk: 0,
  chatFail: 0,
  dropped: 0,
  roomUpdates: 0,
};
const errors = new Map();
const joinMs = [];
const chatMs = [];
const clients = [];
const timers = [];
let closing = false;

function bump(key) {
  errors.set(key, (errors.get(key) ?? 0) + 1);
}

function pct(values, p) {
  if (values.length === 0) return "-";
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

function emitAck(socket, event, payload, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    socket.timeout(timeoutMs).emit(event, payload, (err, res) => {
      const ms = performance.now() - t0;
      if (err) return resolve({ ok: false, code: "TIMEOUT", ms });
      if (res && res.ok === false) return resolve({ ok: false, code: res.error?.code ?? "ERROR", ms });
      resolve({ ok: true, ms });
    });
  });
}

async function createRoom(hostId, displayName) {
  try {
    const res = await fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId, displayName }),
    });
    if (res.status !== 201) {
      bump(`HTTP ${res.status} al crear sala`);
      return null;
    }
    const room = await res.json();
    return room.code;
  } catch (e) {
    bump(`red al crear sala: ${e.cause?.code ?? e.message}`);
    return null;
  }
}

function connect() {
  return new Promise((resolve) => {
    const socket = io(BASE, {
      path: "/socket.io",
      transports: TRANSPORTS,
      reconnection: false,
      timeout: 10000,
    });
    let settled = false;
    socket.on("connect", () => {
      if (settled) return;
      settled = true;
      s.connected++;
      resolve(socket);
    });
    socket.on("connect_error", (e) => {
      if (settled) return;
      settled = true;
      s.connectFail++;
      bump(`connect_error: ${e.message}`);
      resolve(null);
    });
    socket.on("disconnect", (reason) => {
      if (closing) return;
      s.dropped++;
      bump(`desconexion: ${reason}`);
    });
    socket.on("room:updated", () => {
      s.roomUpdates++;
    });
  });
}

async function player(roomCode, playerId, displayName) {
  const socket = await connect();
  if (!socket) return;
  clients.push(socket);

  const joined = await emitAck(socket, "room:join", { roomCode, playerId, displayName });
  joinMs.push(joined.ms);
  if (!joined.ok) {
    s.joinFail++;
    bump(`room:join ${joined.code}`);
    return;
  }
  s.joined++;

  const jitter = Math.random() * 1000;
  timers.push(
    setInterval(async () => {
      if (closing || !socket.connected) return;
      const c = await emitAck(socket, "chat:message", { roomCode, senderId: playerId, content: "hola" });
      chatMs.push(c.ms);
      if (c.ok) s.chatOk++;
      else {
        s.chatFail++;
        bump(`chat:message ${c.code}`);
      }
    }, CHAT_EVERY_S * 1000 + jitter),
  );
}

async function runRoom(r, totalRooms) {
  await sleep((r / totalRooms) * RAMP_S * 1000);
  const size = Math.min(ROOM_SIZE, USERS - r * ROOM_SIZE);
  const hostId = `L${runId}r${r}p0`;
  const code = await createRoom(hostId, `Bot ${r}-0`);
  if (!code) {
    s.roomsFail++;
    return;
  }
  s.rooms++;
  // El host se conecta enseguida: si no, el servidor borra la sala por inactividad.
  await player(code, hostId, `Bot ${r}-0`);
  const others = [];
  for (let i = 1; i < size; i++) {
    others.push(player(code, `L${runId}r${r}p${i}`, `Bot ${r}-${i}`));
    await sleep(150);
  }
  await Promise.all(others);
}

const totalRooms = Math.ceil(USERS / ROOM_SIZE);
console.log(`Prueba: ${USERS} usuarios en ${totalRooms} salas contra ${BASE}`);
console.log(`Entrada en ${RAMP_S}s, luego ${HOLD_S}s conectados. Transportes: ${TRANSPORTS.join(", ")}\n`);

const progress = setInterval(() => {
  console.log(
    `  conectados=${s.connected} unidos=${s.joined} caidos=${s.dropped} chat_ok=${s.chatOk} errores=${[...errors.values()].reduce((a, b) => a + b, 0)}`,
  );
}, 10000);

await Promise.all(Array.from({ length: totalRooms }, (_, r) => runRoom(r, totalRooms)));
console.log(`\nEntraron ${s.joined}/${USERS}. Manteniendo la carga ${HOLD_S}s...`);
await sleep(HOLD_S * 1000);

closing = true;
clearInterval(progress);
timers.forEach(clearInterval);
clients.forEach((c) => c.disconnect());

console.log("\n===== RESULTADO =====");
console.log(`Salas creadas:        ${s.rooms}/${totalRooms} (fallidas: ${s.roomsFail})`);
console.log(`Conexiones OK:        ${s.connected}/${USERS} (fallidas: ${s.connectFail})`);
console.log(`room:join OK:         ${s.joined}/${USERS} (fallidos: ${s.joinFail})`);
console.log(`Chat OK / fallido:    ${s.chatOk} / ${s.chatFail}`);
console.log(`Caidas inesperadas:   ${s.dropped}`);
console.log(`room:updated recibidos: ${s.roomUpdates}`);
console.log(`Latencia room:join (ms): p50=${pct(joinMs, 50)} p95=${pct(joinMs, 95)} max=${pct(joinMs, 100)}`);
console.log(`Latencia chat (ms):      p50=${pct(chatMs, 50)} p95=${pct(chatMs, 95)} max=${pct(chatMs, 100)}`);
if (errors.size > 0) {
  console.log("\nErrores:");
  for (const [k, v] of errors) console.log(`  ${v} x ${k}`);
}

const joinP95 = pct(joinMs, 95);
const pass =
  s.roomsFail === 0 && s.connectFail === 0 && s.joinFail === 0 && s.dropped === 0 && (joinP95 === "-" || joinP95 < 2000);
console.log(`\nVeredicto: ${pass ? "PASA (sin errores, join p95 < 2 s)" : "NO PASA: revisa los errores de arriba"}`);
process.exit(pass ? 0 : 1);
