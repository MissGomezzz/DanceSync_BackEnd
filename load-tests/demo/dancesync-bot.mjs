// Bot de demostración de DanceSync (REN-1 y protección ante abuso).
//
//   node dancesync-bot.mjs ataque     --url <gateway> --sala <CÓDIGO> [--tasa 200] [--reintentos 8]
//   node dancesync-bot.mjs conexiones --url <gateway> --sala <CÓDIGO> [--n 20] [--segundos 60] [--reconectar]
//   node dancesync-bot.mjs http       --url <gateway> [--sala ZZZZZZ] [--n 40]
//
// ataque:     entra como invitado a la sala e inunda el chat a --tasa eventos por segundo. Muestra
//             cuándo el servidor lo limita (rate:limited), cuándo lo bloquea (rate:blocked) y
//             cómo rechaza sus reconexiones mientras dura el bloqueo (BLOCKED).
// conexiones: abre --n conexiones de invitado y las mantiene --segundos, para ver en el
//             balanceador cómo se reparten entre las réplicas. Con --reconectar, una conexión que se cae
//             vuelve a conectarse y a entrar a la sala, como el frontend, y se mide cuánto tardó (DIS-1).
// http:       --n peticiones seguidas de token de invitado: primero responde normal y, al agotar
//             el límite por IP del gateway, 429.
//
// Necesita Node 18 o más y socket.io-client (npm install). Solo usa la API pública, como el frontend.
import { io } from "socket.io-client";

const [mode, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : fallback;
};
const BASE = String(opt("url", "")).replace(/\/+$/, "");
const ROOM = String(opt("sala", "")).trim().toUpperCase();
if (ROOM.startsWith("-") || (ROOM && !/^[A-Z0-9]{4,12}$/.test(ROOM))) {
  console.error(`Código de sala no válido: "${ROOM}". ¿Definiste la variable que usas en --sala?`);
  process.exit(2);
}
if (!["ataque", "conexiones", "http"].includes(mode) || !BASE || (mode !== "http" && !ROOM)) {
  console.error("Uso:\n  node dancesync-bot.mjs ataque     --url <gateway> --sala <CÓDIGO> [--tasa 200] [--reintentos 8]");
  console.error("  node dancesync-bot.mjs conexiones --url <gateway> --sala <CÓDIGO> [--n 20] [--segundos 60] [--reconectar]");
  console.error("  node dancesync-bot.mjs http       --url <gateway> [--sala ZZZZZZ] [--n 40]");
  process.exit(2);
}

const T0 = performance.now();
const t = () => `${String(Math.round(performance.now() - T0)).padStart(6)} ms`;
const log = (msg) => console.log(`[${t()}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function guestToken(name) {
  const res = await fetch(`${BASE}/api/rooms/${encodeURIComponent(ROOM)}/guest-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: name }),
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 201) {
    const retry = res.headers.get("retry-after");
    throw new Error(`token de invitado: HTTP ${res.status}${retry ? ` (Retry-After ${retry} s)` : ""}${body?.error ? ` ${body.error}` : ""}`);
  }
  return body;
}

/** Abre una conexión; resuelve { socket } o { error, data } si el servidor la rechaza. */
function connect(token) {
  return new Promise((resolve) => {
    const socket = io(BASE, { path: "/socket.io", transports: ["websocket"], reconnection: false, timeout: 15000, auth: { token } });
    socket.once("connect", () => resolve({ socket }));
    socket.once("connect_error", (err) => {
      socket.close();
      resolve({ error: err?.message ?? "connect_error", data: err?.data });
    });
  });
}

const join = (socket, displayName) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: { code: "TIMEOUT" } }), 8000);
    socket.emit("room:join", { roomCode: ROOM, displayName }, (r) => {
      clearTimeout(timer);
      resolve(r ?? { ok: false, error: { code: "SIN_RESPUESTA" } });
    });
  });

// ------------------------------------------------------------------------------------------------
async function ataque() {
  const rate = Number(opt("tasa", 200));
  const retries = Number(opt("reintentos", 8));
  const name = opt("nombre", "Bot atacante");
  console.log(`\n=== Ataque: ${rate} eventos de chat por segundo contra la sala ${ROOM} (${BASE}) ===\n`);

  const guest = await guestToken(name);
  log(`token de invitado recibido (jugador ${guest.playerId})`);
  const first = await connect(guest.token);
  if (!first.socket) {
    log(`conexión rechazada: ${first.error} ${first.data?.retryAfterMs ? `(faltan ${Math.ceil(first.data.retryAfterMs / 1000)} s de bloqueo)` : ""}`);
    process.exit(1);
  }
  const socket = first.socket;
  log("conectado por WebSocket");
  const joined = await join(socket, name);
  log(joined.ok ? "entró a la sala" : `no pudo entrar a la sala (${joined.error?.code}); inunda igual: el límite se aplica a cada evento antes de procesarlo`);

  let sent = 0, refusedAcks = 0, firstLimited = null, blockedAt = null, floodStart = null;
  socket.on("rate:limited", (p) => {
    if (firstLimited === null) {
      firstLimited = performance.now() - floodStart;
      log(`LIMITADO a los ${Math.round(firstLimited)} ms de empezar: el servidor descarta los eventos que sobran (descartados: ${p?.dropped ?? "?"})`);
    }
  });
  socket.on("rate:blocked", (p) => {
    blockedAt = performance.now() - floodStart;
    log(`BLOQUEADO a los ${Math.round(blockedAt)} ms de empezar, durante ${Math.round((p?.retryAfterMs ?? 0) / 1000)} s`);
  });

  await new Promise((resolve) => {
    floodStart = performance.now();
    log(`empieza la inundación a ${rate} eventos por segundo...`);
    const perTick = Math.max(1, Math.round(rate / 100));
    let i = 0;
    const timer = setInterval(() => {
      if (!socket.connected) return;
      for (let k = 0; k < perTick; k += 1) {
        sent += 1;
        socket.emit("chat:message", { roomCode: ROOM, content: `spam ${i++}` }, (r) => {
          if (r && r.ok === false && r.error?.code === "RATE_LIMITED") refusedAcks += 1;
        });
      }
    }, 10);
    const stop = (why) => {
      clearInterval(timer);
      log(`el servidor cerró la conexión (${why})`);
      resolve();
    };
    socket.once("disconnect", stop);
    setTimeout(() => {
      if (socket.connected) {
        clearInterval(timer);
        log("20 s sin bloqueo: se detiene la inundación");
        socket.disconnect();
      }
    }, 20000);
  });
  console.log(`\n    Eventos intentados: ${sent} | rechazados con RATE_LIMITED: ${refusedAcks}\n`);

  log(`intenta reconectarse cada segundo (${retries} intentos), como haría un atacante...`);
  for (let n = 1; n <= retries; n += 1) {
    await sleep(1000);
    const again = await connect(guest.token);
    if (again.socket) {
      log(`intento ${n}: aceptado (el bloqueo terminó)`);
      again.socket.disconnect();
      break;
    }
    const left = again.data?.retryAfterMs ? `, faltan ${Math.ceil(again.data.retryAfterMs / 1000)} s` : "";
    log(`intento ${n}: RECHAZADO (${again.error}${left})`);
    if (n === 2) {
      // ¿Y con una identidad nueva desde la misma IP? El bloqueo también es por IP.
      try {
        const fresh = await guestToken(`${name} 2`);
        const other = await connect(fresh.token);
        if (other.socket) {
          log("         con un token de invitado NUEVO: aceptado (el bloqueo por IP no se aplicó)");
          other.socket.disconnect();
        } else log(`         con un token de invitado NUEVO desde la misma IP: también RECHAZADO (${other.error})`);
      } catch (e) {
        log(`         con un token de invitado NUEVO: ${e.message}`);
      }
    }
  }
  console.log("\nResumen:");
  console.log(`  limitado a los ${firstLimited === null ? "-" : Math.round(firstLimited) + " ms"} | bloqueado a los ${blockedAt === null ? "-" : Math.round(blockedAt) + " ms"} (criterio: limitado en < 1 s)`);
  console.log("  Los incidentes quedan en el registro del Battle Service (abuse.rate_limited, abuse.blocked, abuse.refused)");
  console.log("  y en el Admin console (resultado rate_limited / blocked, alerta ClientBlocked).\n");
  process.exit(0);
}

// ------------------------------------------------------------------------------------------------
async function conexiones() {
  const n = Number(opt("n", 20));
  const seconds = Number(opt("segundos", 60));
  const reconnect = rest.includes("--reconectar");
  console.log(`\n=== ${n} conexiones de invitado a la sala ${ROOM}, mantenidas ${seconds} s${reconnect ? ", con reconexión" : ""} (${BASE}) ===\n`);
  const bots = [];
  let stopping = false;
  const recoveries = [];

  const watch = (bot) => {
    bot.socket.once("disconnect", async (reason) => {
      if (stopping) return;
      const lostAt = performance.now();
      log(`conexión ${bot.i}: SE CAYÓ (${reason})${reconnect ? ", reconectando..." : ""}`);
      if (!reconnect) return;
      for (;;) {
        if (stopping) return;
        await sleep(500);
        const c = await connect(bot.token);
        if (!c.socket) continue;
        bot.socket = c.socket;
        const j = await join(c.socket, bot.name);
        const ms = Math.round(performance.now() - lostAt);
        recoveries.push(ms);
        log(`conexión ${bot.i}: RECUPERADA en ${ms} ms${j.ok ? ", de vuelta en la sala" : ` (${j.error?.code})`}`);
        watch(bot);
        return;
      }
    });
  };

  for (let i = 1; i <= n; i += 1) {
    try {
      const name = `Bot ${i}`;
      const guest = await guestToken(name);
      const c = await connect(guest.token);
      if (!c.socket) {
        log(`conexión ${i}: rechazada (${c.error})`);
      } else {
        const bot = { i, name, token: guest.token, socket: c.socket };
        bots.push(bot);
        const j = await join(c.socket, name);
        log(`conexión ${i}: abierta${j.ok ? " y dentro de la sala" : ` (sin asiento: ${j.error?.code}; la conexión sigue abierta)`}`);
        watch(bot);
      }
    } catch (e) {
      log(`conexión ${i}: ${e.message}`);
    }
    await sleep(300); // por debajo de los límites del gateway (5 tokens y 5 conexiones por segundo por IP)
  }
  const open = () => bots.filter((b) => b.socket.connected).length;
  log(`${open()} conexiones abiertas. Mira el balanceador (lb-status y sus logs).`);
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await sleep(Math.min(10000, until - Date.now()));
    log(`siguen abiertas: ${open()}`);
  }
  stopping = true;
  bots.forEach((b) => b.socket.disconnect());
  if (recoveries.length) {
    const sorted = [...recoveries].sort((a, b) => a - b);
    log(`reconexiones: ${sorted.length}, la más lenta ${sorted.at(-1)} ms, mediana ${sorted[Math.floor(sorted.length / 2)]} ms (DIS-1: < 30 s)`);
  }
  log("conexiones cerradas: ahora el log de nginx muestra una línea 101 por cada una, con su réplica");
  setTimeout(() => process.exit(0), 500);
}

// ------------------------------------------------------------------------------------------------
async function http() {
  const n = Number(opt("n", 40));
  const room = ROOM || "ZZZZZZ";
  console.log(`\n=== ${n} peticiones seguidas de token de invitado (${BASE}/api/rooms/${room}/guest-token) ===\n`);
  const codes = [];
  for (let i = 1; i <= n; i += 1) {
    const res = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/guest-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Bot http" }),
    });
    codes.push(res.status);
    const retry = res.headers.get("retry-after");
    if (res.status === 429 && codes.filter((c) => c === 429).length === 1) log(`petición ${i}: 429 Too Many Requests${retry ? ` (Retry-After ${retry} s)` : ""} <- límite por IP del gateway`);
  }
  const count = codes.reduce((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {});
  log(`códigos: ${codes.join(" ")}`);
  log(`resumen: ${Object.entries(count).map(([c, k]) => `${k} x ${c}`).join(", ")}`);
}

({ ataque, conexiones, http })[mode]().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
