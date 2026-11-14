"use strict";
/**
 * REN-1: bot de sala para Artillery.
 *
 * Cada "usuario virtual" de Artillery es UNA SALA de ROOM_SIZE jugadores (7 por defecto):
 * 2 bailarines y el resto espectadores. La sala juega el flujo real y lo repite
 * (rematch) hasta que se acaba el tiempo total de la prueba:
 *
 *   crear sala (HTTP) -> join -> role:select -> player:ready
 *   -> song-challenge:start -> frase -> song:choose -> battle:started
 *   -> durante la canción: chat, votos y word:submit (ráfaga al abrir cada ronda)
 *   -> battle:finished -> room:rematch -> player:ready -> siguiente ciclo
 *
 * Latencias (en ms, medidas desde el cliente, incluyen la red):
 *   dancesync.chat_e2e_ms  chat:message enviado -> misma difusión recibida por el emisor
 *   dancesync.vote_e2e_ms  vote:cast enviado    -> vote:mine recibido (llega después de room:updated)
 *   dancesync.word_e2e_ms  word:submit ganador  -> word:round-ended recibido
 *   dancesync.ack_ms       cualquier evento     -> acuse de recibo del servidor
 *
 * Contadores de verificación (todos deben quedar en 0 salvo events_sent / battles_completed):
 *   dancesync.errors              timeouts, caídas inesperadas, fallos de conexión, INTERNAL_ERROR, HTTP != 201
 *   dancesync.duplicate_round_end un cliente vio dos veces el fin de la misma ronda
 *   dancesync.winner_mismatch     dos clientes de la misma sala vieron ganadores distintos de una ronda
 *   dancesync.score_mismatch      las rondas ganadas del puntaje final no coinciden con las rondas vistas
 *
 * Parámetros: `-t URL` (destino) y las variables del escenario (totalS, roomSize, eventEveryMs).
 * Variables de entorno opcionales: BASE, TRANSPORTS, AUTH_MODE (fake|none), ACK_TIMEOUT_MS.
 */
const { io } = require("socket.io-client");
const { mintEntraToken } = require("./fake-entra.cjs");

// El destino sale de `artillery run -t URL` (context.vars.target) o, si no, de la variable BASE.
let BASE = (process.env.BASE || "http://localhost:8080").replace(/\/$/, "");
// Estos tres valores salen de config.variables del escenario (totalS, roomSize, eventEveryMs).
let TOTAL_S = 660;
let ROOM_SIZE = 7;
let EVENT_EVERY_MS = 2000;
const ACK_TIMEOUT_MS = Number(process.env.ACK_TIMEOUT_MS || 10000);
const TRANSPORTS = (process.env.TRANSPORTS || "websocket").split(",");
// SEG-1: "fake" (por defecto) = el anfitrión entra con un token tipo Entra ID firmado localmente y los demás
// como invitados (token que emite el propio servicio). "none" = servidor sin autenticación (código anterior a SEG-1).
const AUTH_MODE = (process.env.AUTH_MODE || "fake").toLowerCase();
const SONG_IDS = ["song-1", "song-2", "song-3", "song-4", "song-5", "song-6"];

// La primera sala que arranca marca el inicio de la prueba; todas terminan en END_AT.
let END_AT = 0;
const RUN_ID = Math.random().toString(36).slice(2, 6);
let roomSeq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (max) => Math.random() * max;

/** Domain rejections that are normal in a race (lost a race, vote at the buzzer...). */
const EXPECTED_CODES = new Set([
  "SONG_SELECTION_NOT_ACTIVE",
  "ATTEMPT_ALREADY_USED",
  "BATTLE_FINISHED",
  "BATTLE_NOT_STARTED",
  "WORD_ROUND_NOT_OPEN",
  "WORD_RACE_NOT_ACTIVE",
]);

function makeMetrics(events) {
  return {
    hist: (name, value) => events.emit("histogram", `dancesync.${name}`, value),
    count: (name, n = 1) => events.emit("counter", `dancesync.${name}`, n),
  };
}

/** Emits with an ack and measures it. Resolves { ok, code, ms, data }; never rejects. */
function emitAck(room, bot, event, payload) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    room.m.count("events_sent");
    bot.socket.timeout(ACK_TIMEOUT_MS).emit(event, payload, (err, res) => {
      const ms = performance.now() - t0;
      if (err) {
        room.m.count("errors");
        return resolve({ ok: false, code: "TIMEOUT", ms });
      }
      room.m.hist("ack_ms", ms);
      if (res && res.ok === false) {
        const code = res.error?.code ?? "ERROR";
        if (EXPECTED_CODES.has(code)) room.m.count("domain_rejections");
        else room.m.count("errors");
        return resolve({ ok: false, code, ms });
      }
      resolve({ ok: true, ms, data: res?.data });
    });
  });
}

/** Resolves with the first payload of `event` accepted by `predicate`, or rejects after `timeoutMs`. */
function waitFor(socket, event, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout esperando ${event}`));
    }, timeoutMs);
    function handler(payload) {
      if (predicate && !predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

function connect(room, bot) {
  return new Promise((resolve) => {
    const socket = io(BASE, {
      path: "/socket.io",
      transports: TRANSPORTS,
      reconnection: false,
      timeout: 10000,
      auth: bot.token ? { token: bot.token } : undefined,
    });
    bot.socket = socket;
    let settled = false;
    socket.on("connect", () => {
      if (settled) return;
      settled = true;
      resolve(true);
    });
    socket.on("connect_error", () => {
      if (settled) return;
      settled = true;
      room.m.count("errors");
      resolve(false);
    });
    socket.on("disconnect", () => {
      if (!room.closing) room.m.count("errors");
    });
    attachListeners(room, bot);
  });
}

function attachListeners(room, bot) {
  const { socket } = bot;

  socket.on("room:updated", () => room.m.count("room_updates_received"));

  // Chat: el emisor también recibe su propia difusión; de ahí sale la latencia de extremo a extremo.
  socket.on("chat:message", (msg) => {
    if (msg.senderId !== bot.id) return;
    const t0 = bot.pendingChat.get(msg.content);
    if (t0 === undefined) return;
    bot.pendingChat.delete(msg.content);
    room.m.hist("chat_e2e_ms", performance.now() - t0);
  });

  // Voto: vote:mine se emite justo después de publicar el estado nuevo de la sala.
  socket.on("vote:mine", (payload) => {
    if (bot.pendingVote === null) return;
    const { t0, dancerId } = bot.pendingVote;
    if (payload.dancerId !== dancerId) return;
    bot.pendingVote = null;
    bot.currentVote = payload.dancerId;
    room.m.hist("vote_e2e_ms", performance.now() - t0);
  });

  socket.on("battle:started", (dto) => {
    room.votingFrom = Date.now() + Math.max(0, dto.battle?.startsInMs ?? 0) + 200;
    room.roundsWon = 0;
    room.roundWinners.clear();
  });

  // Palabra: los bailarines responden casi a la vez (ráfaga) y solo uno puede ganar.
  socket.on("word:round-started", (round) => {
    if (bot.role !== "dancer") return;
    setTimeout(async () => {
      if (room.closing) return;
      // El fin de ronda se difunde antes de que llegue el acuse: el t0 se guarda antes de emitir.
      bot.pendingWord.set(round.roundId, performance.now());
      const r = await emitAck(room, bot, "word:submit", {
        roomCode: room.code,
        playerId: bot.id,
        roundId: round.roundId,
        text: round.word,
      });
      if (!r.ok || r.data?.outcome !== "won") bot.pendingWord.delete(round.roundId);
    }, rand(150));
  });

  socket.on("word:round-ended", (end) => {
    // Un solo fin por ronda y por cliente.
    if (bot.seenRounds.has(end.roundId)) room.m.count("duplicate_round_end");
    bot.seenRounds.add(end.roundId);
    // Todos los clientes de la sala deben ver el mismo ganador.
    const known = room.roundWinners.get(end.roundId);
    if (known === undefined) room.roundWinners.set(end.roundId, end.winnerId);
    else if (known !== end.winnerId) room.m.count("winner_mismatch");
    // Solo el bot observador cuenta las rondas ganadas para la verificación de puntajes.
    if (bot.index === 0) {
      room.m.count("word_rounds_seen");
      if (end.reason === "won") room.roundsWon += 1;
    }
    const t0 = end.winnerId === bot.id ? bot.pendingWord.get(end.roundId) : undefined;
    if (t0 !== undefined) {
      bot.pendingWord.delete(end.roundId);
      room.m.hist("word_e2e_ms", performance.now() - t0);
    }
  });

  socket.on("battle:finished", (dto) => {
    if (bot.index !== 0) return;
    const wins = Object.values(dto.battle?.wordsWon ?? {}).reduce((a, b) => a + b, 0);
    if (wins !== room.roundsWon) room.m.count("score_mismatch");
  });
}

/** Ritmo de la prueba: un evento cada EVENT_EVERY_MS por usuario (con jitter). */
async function trafficLoop(room, bot) {
  await sleep(rand(EVENT_EVERY_MS));
  let tick = 0;
  while (!room.closing) {
    tick += 1;
    const canVote = bot.role === "spectator" && Date.now() >= room.votingFrom && room.dancers.length >= 2;
    if (canVote && tick % 2 === 0) {
      // Alterna entre los dos bailarines para que cada voto cambie el estado.
      const next = room.dancers.find((d) => d.id !== bot.currentVote) ?? room.dancers[0];
      bot.pendingVote = { t0: performance.now(), dancerId: next.id };
      const r = await emitAck(room, bot, "vote:cast", { roomCode: room.code, voterId: bot.id, dancerId: next.id });
      if (!r.ok) bot.pendingVote = null;
    } else {
      const content = `m${bot.index}-${tick}`;
      bot.pendingChat.set(content, performance.now());
      const r = await emitAck(room, bot, "chat:message", { roomCode: room.code, senderId: bot.id, content });
      if (!r.ok) bot.pendingChat.delete(content);
    }
    await sleep(EVENT_EVERY_MS * (0.75 + Math.random() * 0.5));
  }
}

async function createRoom(room, host) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(host.token ? { Authorization: `Bearer ${host.token}` } : {}),
      },
      body: JSON.stringify({ hostId: host.id, displayName: host.name }),
    });
    room.m.hist("http_create_room_ms", performance.now() - t0);
    if (res.status !== 201) {
      console.error(`[crear sala] HTTP ${res.status} en ${BASE}`);
      room.m.count("errors");
      return null;
    }
    return (await res.json()).code;
  } catch (error) {
    console.error(`[crear sala] ${BASE}: ${error.cause?.code ?? error.message}`);
    room.m.count("errors");
    return null;
  }
}

/** Un invitado entra con el código de la sala: el servicio le da un token y le asigna su id. */
async function getGuestToken(room, bot) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/rooms/${room.code}/guest-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: bot.name }),
    });
    room.m.hist("guest_token_ms", performance.now() - t0);
    if (res.status !== 201) {
      console.error(`[token invitado] HTTP ${res.status} en ${BASE}`);
      room.m.count("errors");
      return false;
    }
    const guest = await res.json();
    bot.token = guest.token;
    bot.id = guest.playerId;
    return true;
  } catch (error) {
    console.error(`[token invitado] ${BASE}: ${error.cause?.code ?? error.message}`);
    room.m.count("errors");
    return false;
  }
}

async function readyEveryone(room) {
  await Promise.all(room.bots.map((b) => emitAck(room, b, "player:ready", { roomCode: room.code, playerId: b.id, ready: true })));
}

/** Un ciclo completo: reto de la canción -> batalla -> rematch. */
async function runCycle(room) {
  const host = room.bots[0];
  const challenge = await emitAck(room, host, "song-challenge:start", { roomCode: room.code, requesterId: host.id });
  if (!challenge.ok) throw new Error(`song-challenge:start ${challenge.code}`);
  const phrase = challenge.data?.songSelection?.challenge?.phrase;
  if (!phrase) throw new Error("la sala no trajo la frase del reto");

  const results = await Promise.all(
    room.dancers.map(async (d) => {
      await sleep(rand(150));
      return { d, r: await emitAck(room, d, "song-challenge:submit", { roomCode: room.code, playerId: d.id, text: phrase }) };
    }),
  );
  const winner = results.find((x) => x.r.ok && x.r.data?.outcome === "accepted");
  if (!winner) throw new Error("nadie ganó el reto de la frase");

  const started = waitFor(host.socket, "battle:started", null, 15000);
  const chosen = await emitAck(room, winner.d, "song:choose", {
    roomCode: room.code,
    playerId: winner.d.id,
    songId: SONG_IDS[Math.floor(Math.random() * SONG_IDS.length)],
  });
  if (!chosen.ok) throw new Error(`song:choose ${chosen.code}`);
  const battle = await started;

  const wait = Math.max(0, (battle.battle?.endsInMs ?? 95000)) + 30000;
  await waitFor(host.socket, "battle:finished", null, wait);
  room.m.count("battles_completed");

  // Menos votos y tráfico mientras se vuelve al lobby: se repite en el siguiente ciclo.
  room.votingFrom = Infinity;
  const rematch = await emitAck(room, host, "room:rematch", { roomCode: room.code, requesterId: host.id });
  if (!rematch.ok) throw new Error(`room:rematch ${rematch.code}`);
  await readyEveryone(room);
}

/** Función de flujo de Artillery: una sala completa. */
async function runRoomAsync(context, events) {
  if (END_AT === 0) {
    const v = context.vars || {};
    if (v.target) BASE = String(v.target).replace(/\/$/, "");
    TOTAL_S = Number(v.totalS ?? process.env.TOTAL_S ?? TOTAL_S);
    ROOM_SIZE = Math.min(Number(v.roomSize ?? process.env.ROOM_SIZE ?? ROOM_SIZE), 7);
    EVENT_EVERY_MS = Number(v.eventEveryMs ?? process.env.EVENT_EVERY_MS ?? EVENT_EVERY_MS);
    END_AT = Date.now() + TOTAL_S * 1000;
  }
  const n = roomSeq++;
  const room = {
    code: "",
    m: makeMetrics(events),
    closing: false,
    votingFrom: Infinity,
    roundsWon: 0,
    roundWinners: new Map(),
    bots: [],
    dancers: [],
  };
  for (let i = 0; i < ROOM_SIZE; i += 1) {
    room.bots.push({
      index: i,
      id: `L${RUN_ID}r${n}p${i}`,
      name: `Bot ${n}-${i}`,
      role: i < 2 ? "dancer" : "spectator",
      socket: null,
      pendingChat: new Map(),
      pendingVote: null,
      pendingWord: new Map(),
      seenRounds: new Set(),
      currentVote: null,
      token: "",
    });
  }
  room.dancers = room.bots.filter((b) => b.role === "dancer");

  try {
    const host = room.bots[0];
    if (AUTH_MODE === "fake") host.token = mintEntraToken({ oid: host.id, name: host.name });
    room.code = await createRoom(room, host);
    if (!room.code) throw new Error("no se pudo crear la sala");

    // El anfitrión se conecta de inmediato: si no, el servidor borra la sala por inactividad.
    for (const bot of room.bots) {
      if (AUTH_MODE === "fake" && bot.index !== 0 && !(await getGuestToken(room, bot))) {
        throw new Error("no se pudo obtener el token de invitado");
      }
      if (!(await connect(room, bot))) throw new Error("fallo de conexión");
      const joined = await emitAck(room, bot, "room:join", { roomCode: room.code, playerId: bot.id, displayName: bot.name });
      if (!joined.ok) throw new Error(`room:join ${joined.code}`);
      await sleep(rand(100));
    }
    for (const bot of room.bots) {
      const r = await emitAck(room, bot, "role:select", { roomCode: room.code, playerId: bot.id, role: bot.role });
      if (!r.ok) throw new Error(`role:select ${r.code}`);
    }
    await readyEveryone(room);

    const loops = room.bots.map((bot) => trafficLoop(room, bot));
    do {
      await runCycle(room);
    } while (Date.now() < END_AT);

    room.closing = true;
    await Promise.all(loops);
  } catch (error) {
    room.m.count("room_failures");
    room.m.count("errors");
    console.error(`[sala ${room.code || n}] ${error.message}`);
  } finally {
    room.closing = true;
    for (const bot of room.bots) bot.socket?.disconnect();
  }
}

// Artillery espera una función con callback; el flujo real es asíncrono.
function runRoom(context, events, done) {
  runRoomAsync(context, events).then(
    () => done(),
    (error) => done(error),
  );
}

module.exports = { runRoom };
