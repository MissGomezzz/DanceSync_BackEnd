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
const { monitorEventLoopDelay } = require("node:perf_hooks");
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

/** SEG-3: ventana del ataque (la fijan los clientes abusivos). Fuera de una prueba de abuso queda en 0. */
let ATTACK_FROM = 0;
let ATTACK_UNTIL = 0;
const attackActive = () => {
  const now = Date.now();
  return ATTACK_FROM > 0 && now >= ATTACK_FROM && now <= ATTACK_UNTIL;
};
const MEASURED_DURING_ATTACK = new Set(["chat_e2e_ms", "vote_e2e_ms", "ack_ms"]);

function makeMetrics(events) {
  return {
    hist: (name, value) => {
      events.emit("histogram", `dancesync.${name}`, value);
      // Las latencias de los usuarios normales mientras dura el ataque, aparte, para compararlas (SEG-3).
      if (MEASURED_DURING_ATTACK.has(name) && attackActive()) {
        events.emit("histogram", `dancesync.attack_window.${name}`, value);
      }
    },
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
      // Cada sala sale de su propia dirección, como detrás de un proxy de confianza (SEG-3).
      extraHeaders: room.ip ? { "x-forwarded-for": room.ip } : undefined,
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
        ...(room.ip ? { "X-Forwarded-For": room.ip } : {}),
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
      headers: { "Content-Type": "application/json", ...(room.ip ? { "X-Forwarded-For": room.ip } : {}) },
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

/**
 * ¿Está saturado el propio generador de carga? Si el bucle de eventos de este proceso se retrasa, las latencias
 * medidas desde aquí incluyen ese retraso y no son del servidor. Cada 5 s se reporta el p95 del retraso (ms).
 */
const LOOP_RESOLUTION_MS = 20;
function watchGeneratorHealth(events) {
  const histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  histogram.enable();
  setInterval(() => {
    // El histograma incluye la resolución como base: lo que excede de ella es retraso real.
    const lag = Math.max(0, histogram.percentile(95) / 1e6 - LOOP_RESOLUTION_MS);
    events.emit("histogram", "dancesync.generator_loop_lag_ms", lag);
    histogram.reset();
  }, 5000).unref();
}

function init(context, events) {
  if (END_AT === 0) {
    const v = context.vars || {};
    if (v.target) BASE = String(v.target).replace(/\/$/, "");
    TOTAL_S = Number(v.totalS ?? process.env.TOTAL_S ?? TOTAL_S);
    ROOM_SIZE = Math.min(Number(v.roomSize ?? process.env.ROOM_SIZE ?? ROOM_SIZE), 7);
    EVENT_EVERY_MS = Number(v.eventEveryMs ?? process.env.EVENT_EVERY_MS ?? EVENT_EVERY_MS);
    END_AT = Date.now() + TOTAL_S * 1000;
    watchGeneratorHealth(events);
  }
}

/** Dirección simulada de la sala n, en el rango reservado para pruebas de rendimiento (RFC 2544). */
const roomAddress = (n) => `198.18.${Math.floor(n / 250)}.${(n % 250) + 1}`;

/** Función de flujo de Artillery: una sala completa. */
async function runRoomAsync(context, events) {
  init(context, events);
  const n = roomSeq++;
  const room = {
    ip: roomAddress(n),
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

/* ------------------------------------------------------------------------------------------
 * SEG-3: cliente abusivo.
 *
 * Cada uno sale de su propia dirección (198.19.255.x), crea su sala, entra y envía
 * `abuseEventsPerSecond` eventos de chat por segundo. Cuando el servidor lo bloquea y cierra
 * la conexión, insiste: intenta reconectarse cada segundo con el mismo token y, una vez, con
 * un token de invitado nuevo desde la misma dirección. Si un intento entra (el bloqueo
 * terminó), vuelve a inundar. Así hasta `abuseDurationS`.
 *
 * Métricas (no se mezclan con las de los usuarios normales):
 *   dancesync.abuse.first_limited_ms   inicio de la inundación -> primer rate:limited
 *   dancesync.abuse.blocked_ms         inicio de la inundación -> rate:blocked
 *   dancesync.abuse.events_sent        eventos que intentó enviar
 *   dancesync.abuse.blocks             veces que fue bloqueado
 *   dancesync.abuse.reconnect_refused  reconexiones rechazadas (BLOCKED) / reconnect_accepted
 *   dancesync.abuse.ip_block_held      el token nuevo desde la misma dirección también fue rechazado
 *   dancesync.abuse.ip_block_failed    ... o no lo fue (fallo)
 *   dancesync.abuse.setup_failures     no pudo ni empezar (no cuenta como bloqueo)
 * ---------------------------------------------------------------------------------------- */
let abuserSeq = 0;

function abuseMetrics(events) {
  return {
    hist: (name, value) => events.emit("histogram", `dancesync.abuse.${name}`, value),
    count: (name, n = 1) => events.emit("counter", `dancesync.abuse.${name}`, n),
  };
}

/** Abre un socket y resuelve "connected", o el mensaje con que se rechazó el handshake. */
function openSocket(token, ip) {
  return new Promise((resolve) => {
    const socket = io(BASE, {
      path: "/socket.io",
      transports: TRANSPORTS,
      reconnection: false,
      timeout: 10000,
      auth: token ? { token } : undefined,
      extraHeaders: { "x-forwarded-for": ip },
    });
    socket.on("connect", () => resolve({ socket, refused: null }));
    socket.on("connect_error", (error) => {
      socket.close();
      resolve({ socket: null, refused: error?.message ?? "connect_error" });
    });
  });
}

async function postJson(path, body, ip, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: res.status < 300 ? await res.json() : null };
}

/** Inunda hasta que el servidor cierre la conexión o termine el ataque. Resuelve true si lo bloquearon. */
function flood(socket, roomCode, m, ratePerSecond, until) {
  return new Promise((resolve) => {
    const started = performance.now();
    let limitedSeen = false;
    let blocked = false;
    socket.on("rate:limited", () => {
      if (limitedSeen) return;
      limitedSeen = true;
      m.hist("first_limited_ms", performance.now() - started);
    });
    socket.on("rate:blocked", () => {
      blocked = true;
      m.hist("blocked_ms", performance.now() - started);
      m.count("blocks");
    });
    const perTick = Math.max(1, Math.round(ratePerSecond / 100)); // un tick cada 10 ms
    let i = 0;
    const timer = setInterval(() => {
      if (!socket.connected || Date.now() >= until) return;
      for (let k = 0; k < perTick; k += 1) {
        socket.emit("chat:message", { roomCode, content: `spam ${i++}` }, () => {});
        m.count("events_sent");
      }
    }, 10);
    const finish = () => {
      clearInterval(timer);
      resolve(blocked);
    };
    socket.on("disconnect", finish);
    const stopAt = setTimeout(() => {
      socket.disconnect();
    }, Math.max(0, until - Date.now()));
    socket.on("disconnect", () => clearTimeout(stopAt));
  });
}

async function runAbuserAsync(context, events) {
  init(context, events);
  const v = context.vars || {};
  const ratePerSecond = Number(v.abuseEventsPerSecond ?? 200);
  const durationS = Number(v.abuseDurationS ?? 120);
  const k = abuserSeq++;
  const m = abuseMetrics(events);
  const ip = `198.19.255.${k + 1}`;
  const id = `A${RUN_ID}x${k}`;
  const until = Date.now() + durationS * 1000;
  if (ATTACK_FROM === 0 || Date.now() > ATTACK_UNTIL) {
    ATTACK_FROM = Date.now();
    ATTACK_UNTIL = until;
  } else {
    ATTACK_UNTIL = Math.max(ATTACK_UNTIL, until);
  }

  try {
    const token = AUTH_MODE === "fake" ? mintEntraToken({ oid: id, name: `Abuser ${k}` }) : "";
    const created = await postJson("/api/rooms", { hostId: id, displayName: `Abuser ${k}` }, ip, token);
    if (created.status !== 201) throw new Error(`crear sala: HTTP ${created.status}`);
    const roomCode = created.body.code;

    let triedFreshGuest = false;
    while (Date.now() < until) {
      const { socket, refused } = await openSocket(token, ip);
      if (!socket) {
        if (refused === "BLOCKED") m.count("reconnect_refused");
        else m.count("reconnect_other_error");
        if (!triedFreshGuest && refused === "BLOCKED") {
          // ¿Y con una identidad nueva desde la misma dirección? (el bloqueo por IP debe sostenerse)
          triedFreshGuest = true;
          const guest = await postJson(`/api/rooms/${roomCode}/guest-token`, { displayName: "Otro" }, ip);
          if (guest.status === 201) {
            const fresh = await openSocket(guest.body.token, ip);
            if (fresh.socket) {
              m.count("ip_block_failed");
              fresh.socket.disconnect();
            } else m.count(fresh.refused === "BLOCKED" ? "ip_block_held" : "ip_block_other");
          } else m.count("ip_block_held"); // también rechazado antes de llegar al socket (p. ej. 429)
        }
        await sleep(1000);
        continue;
      }
      m.count("reconnect_accepted");
      await new Promise((resolve) => socket.emit("room:join", { roomCode, displayName: `Abuser ${k}` }, resolve));
      await flood(socket, roomCode, m, ratePerSecond, until);
      socket.disconnect();
    }
  } catch (error) {
    m.count("setup_failures");
    console.error(`[abusivo ${k}] ${error.message}`);
  }
}

function runAbuser(context, events, done) {
  runAbuserAsync(context, events).then(
    () => done(),
    (error) => done(error),
  );
}

/**
 * SEG-3: una sola función de flujo para salas normales y clientes abusivos. Las primeras
 * `rooms` llegadas son salas y las siguientes, abusivos. Funciona porque las fases con
 * arrivalCount corren completas en un solo proceso de Artillery.
 */
let mixedSeq = 0;
function runMixed(context, events, done) {
  const rooms = Number(context.vars?.rooms ?? 20);
  return mixedSeq++ < rooms ? runRoom(context, events, done) : runAbuser(context, events, done);
}

module.exports = { runRoom, runAbuser, runMixed };
