// OBS-1: shared helpers of the observability measurement scripts (obs-metrics-lag, obs-alert-time,
// obs-trace): the docker-compose.observability.yml stack, the Prometheus HTTP API, room bots that play
// through the api-gateway, and the JSON reports.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

const require = createRequire(import.meta.url);
const { mintEntraToken } = require("./fake-entra.cjs");

export const PROJECT = process.env.OBS_PROJECT ?? "obs1";
export const GATEWAY = `http://localhost:${process.env.OBS_GATEWAY_PORT ?? "18080"}`;
export const PROMETHEUS = `http://localhost:${process.env.OBS_PROMETHEUS_PORT ?? "19090"}`;
export const GRAFANA = `http://localhost:${process.env.OBS_GRAFANA_PORT ?? "13300"}`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOAD_TESTS = path.resolve(HERE, "..");
export const REPO = path.resolve(LOAD_TESTS, "..");
const COMPOSE = ["compose", "-p", PROJECT, "-f", path.join(REPO, "docker-compose.observability.yml")];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);

export function option(name, fallback) {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
export const flag = (name) => process.argv.slice(2).includes(`--${name}`);

// --- docker ------------------------------------------------------------------------------------------
export function dockerSync(args, { timeout = 900_000, allowFail = false } = {}) {
  try {
    return execFileSync("docker", args, { cwd: REPO, encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (error) {
    if (allowFail) return null;
    throw new Error(`docker ${args.slice(0, 7).join(" ")} failed: ${error.stderr ?? error.message}`);
  }
}

/** Never execFileSync while bots are connected: it blocks the event loop that answers their heartbeats. */
export function docker(args, { timeout = 120_000, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { cwd: REPO, encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if (allowFail) return resolve(null);
      reject(new Error(`docker ${args.slice(0, 7).join(" ")} failed: ${stderr || error.message}`));
    });
  });
}
export const compose = (args, options) => docker([...COMPOSE, ...args], options);

/** Container id of a compose service (for docker update / docker kill). */
export async function containerOf(service) {
  const out = await compose(["ps", "-a", "-q", service]);
  const id = out.trim().split(/\r?\n/)[0];
  if (!id) throw new Error(`No container for ${service}`);
  return id;
}

export async function healthOf(service) {
  const id = await containerOf(service);
  const out = await docker(["inspect", "-f", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", id], { allowFail: true });
  return (out ?? "").trim();
}

/** Brings the stack up (idempotent: a running stack is left as it is) and waits for the gateway. */
export async function ensureStack({ build = false } = {}) {
  log(`Starting docker-compose.observability.yml (project ${PROJECT})${build ? " with --build" : ""}...`);
  dockerSync([...COMPOSE, "up", "-d", ...(build ? ["--build"] : []), "--wait", "--wait-timeout", "600"]);
  const deadline = Date.now() + 240_000;
  for (;;) {
    const ok = await fetch(`${GATEWAY}/api/battles/health/ready`).then((r) => r.ok, () => false);
    const users = await fetch(`${GATEWAY}/api/matches?limit=1`).then((r) => r.status < 500, () => false);
    const targets = await upTargets().catch(() => null);
    if (ok && users && targets && targets.every((t) => t.up)) break;
    if (Date.now() > deadline) throw new Error(`The stack is not ready: gateway ${ok}, users-service ${users}, targets ${JSON.stringify(targets)}`);
    await sleep(3_000);
  }
  log("Stack ready: gateway answers and every Prometheus target is up.");
}

// --- Prometheus ----------------------------------------------------------------------------------------
export async function promQuery(expr) {
  const res = await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(expr)}`);
  const body = await res.json();
  if (body.status !== "success") throw new Error(`Prometheus query failed: ${body.error ?? res.status}`);
  return body.data.result;
}

/** A single number (sum of every series), or 0 when there is no series yet. */
export async function promValue(expr) {
  const result = await promQuery(expr);
  return result.reduce((total, series) => total + Number(series.value[1]), 0);
}

export async function upTargets() {
  const result = await promQuery("up");
  return result.map((s) => ({ job: s.metric.job, instance: s.metric.instance, up: s.value[1] === "1" }));
}

export async function alerts() {
  const res = await fetch(`${PROMETHEUS}/api/v1/alerts`);
  const body = await res.json();
  return body.data.alerts;
}

// --- Gateway HTTP --------------------------------------------------------------------------------------
export async function post(url, body, { token, ip, correlationId } = {}) {
  const res = await fetch(`${GATEWAY}${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(ip ? { "x-forwarded-for": ip } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(correlationId ? { "x-correlation-id": correlationId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`POST ${url}: HTTP ${res.status}`);
  return { body: await res.json(), correlationId: res.headers.get("x-correlation-id") };
}

export { mintEntraToken };

// --- Room bots through the gateway ---------------------------------------------------------------------
const ACK_TIMEOUT_MS = 10_000;

export function emitAck(bot, event, payload) {
  return new Promise((resolve) => {
    if (!bot.socket) return resolve({ ok: false, code: "NO_SOCKET" });
    bot.socket.timeout(ACK_TIMEOUT_MS).emit(event, payload, (error, response) => {
      if (error) return resolve({ ok: false, code: "TIMEOUT" });
      if (response?.ok === false) return resolve({ ok: false, code: response.error?.code ?? "ERROR" });
      resolve({ ok: true, data: response?.data });
    });
  });
}

export function waitFor(socket, event, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
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

/** Opens a Socket.IO connection through the gateway, WebSocket only, with the frontend's reconnection. */
export function connectBot(room, bot, { correlationId, reconnection = true } = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(GATEWAY, {
      path: "/socket.io",
      transports: ["websocket"],
      reconnection,
      timeout: 10_000,
      auth: { token: bot.token },
      extraHeaders: { "x-forwarded-for": room.ip, ...(correlationId ? { "x-correlation-id": correlationId } : {}) },
    });
    bot.socket = socket;
    let first = true;
    socket.on("connect", () => {
      if (first) {
        first = false;
        return resolve();
      }
      // Like the frontend: repeat room:join (idempotent) after a reconnection.
      void emitAck(bot, "room:join", { roomCode: room.code, displayName: bot.name });
    });
    socket.on("connect_error", (error) => {
      if (first) {
        first = false;
        reject(new Error(`connect: ${error.message}`));
      }
    });
  });
}

/**
 * Background load: `rooms` rooms of `roomSize` users (2 dancers, the rest spectators) that play battle
 * after battle through the gateway (challenge, song, votes, word race, chat every `chatEveryMs`) until
 * `stop()` is called. Used to give the dashboards data and to make the alert measures happen under load.
 */
export function startLoad({ rooms = 8, roomSize = 7, chatEveryMs = 2_000, ipBlock = 20 } = {}) {
  const run = Math.random().toString(36).slice(2, 6);
  const state = { rooms: [], stopped: false, battlesFinished: 0, cycleErrors: 0, setupErrors: [] };

  async function cycle(room) {
    const host = room.bots[0];
    const challenge = await emitAck(host, "song-challenge:start", { roomCode: room.code });
    const phrase = challenge.data?.songSelection?.challenge?.phrase;
    if (!challenge.ok || !phrase) throw new Error(`song-challenge:start ${challenge.code ?? "without phrase"}`);
    const dancers = room.bots.filter((b) => b.role === "dancer");
    const answers = await Promise.all(dancers.map(async (d) => ({ d, r: await emitAck(d, "song-challenge:submit", { roomCode: room.code, text: phrase }) })));
    const winner = answers.find((a) => a.r.ok && a.r.data?.outcome === "accepted");
    if (!winner) throw new Error("nobody won the song challenge");
    const started = waitFor(host.socket, "battle:started", null, 20_000);
    const chosen = await emitAck(winner.d, "song:choose", { roomCode: room.code, songId: `song-${1 + Math.floor(Math.random() * 6)}` });
    if (!chosen.ok) throw new Error(`song:choose ${chosen.code}`);
    const battle = await started;
    room.battling = true;
    await waitFor(host.socket, "battle:finished", null, (battle.battle?.endsInMs ?? 95_000) + 30_000);
    room.battling = false;
    state.battlesFinished += 1;
    if (state.stopped) return;
    const rematch = await emitAck(host, "room:rematch", { roomCode: room.code });
    if (!rematch.ok) throw new Error(`room:rematch ${rematch.code}`);
    await Promise.all(room.bots.map((b) => emitAck(b, "player:ready", { roomCode: room.code, ready: true })));
  }

  function listen(room, bot) {
    bot.socket.on("battle:started", (dto) => {
      if (bot.role !== "spectator") return;
      setTimeout(() => {
        const dancer = room.bots[Math.floor(Math.random() * 2)];
        void emitAck(bot, "vote:cast", { roomCode: room.code, dancerId: dancer.id });
      }, Math.max(0, dto.battle?.startsInMs ?? 0) + 300 + Math.random() * 3_000);
    });
    bot.socket.on("word:round-started", (round) => {
      if (bot.role !== "dancer") return;
      setTimeout(() => void emitAck(bot, "word:submit", { roomCode: room.code, roundId: round.roundId, text: round.word }), Math.random() * 300);
    });
  }

  async function chatLoop(room, bot) {
    await sleep(Math.random() * chatEveryMs);
    let n = 0;
    while (!state.stopped) {
      if (bot.socket?.connected) await emitAck(bot, "chat:message", { roomCode: room.code, content: `m${bot.index}-${n++}` });
      await sleep(chatEveryMs * (0.75 + Math.random() * 0.5));
    }
  }

  async function setUp(n) {
    const room = { n, ip: `198.18.${ipBlock + Math.floor(n / 250)}.${(n % 250) + 1}`, code: "", bots: [], battling: false };
    state.rooms.push(room);
    for (let i = 0; i < roomSize; i += 1) {
      room.bots.push({ index: i, id: i === 0 ? `O${run}r${n}host` : "", name: `Obs ${n}-${i}`, role: i < 2 ? "dancer" : "spectator", token: "", socket: null });
    }
    try {
      const host = room.bots[0];
      host.token = mintEntraToken({ oid: host.id, name: host.name });
      room.code = (await post("/api/rooms", { displayName: host.name }, { token: host.token, ip: room.ip })).body.code;
      for (const bot of room.bots) {
        if (bot.index > 0) {
          const guest = (await post(`/api/rooms/${room.code}/guest-token`, { displayName: bot.name }, { ip: room.ip })).body;
          bot.token = guest.token;
          bot.id = guest.playerId;
        }
        await connectBot(room, bot);
        listen(room, bot);
        const joined = await emitAck(bot, "room:join", { roomCode: room.code, displayName: bot.name });
        if (!joined.ok) throw new Error(`room:join ${joined.code}`);
      }
      for (const bot of room.bots) {
        const r = await emitAck(bot, "role:select", { roomCode: room.code, role: bot.role });
        if (!r.ok) throw new Error(`role:select ${r.code}`);
      }
      await Promise.all(room.bots.map((b) => emitAck(b, "player:ready", { roomCode: room.code, ready: true })));
      for (const bot of room.bots) void chatLoop(room, bot);
      while (!state.stopped) {
        try {
          await cycle(room);
        } catch (error) {
          state.cycleErrors += 1;
          room.battling = false;
          // A replica died or Redis was slowed down on purpose: back to the lobby and try again.
          await sleep(3_000);
          if (state.stopped) break;
          await emitAck(room.bots[0], "room:rematch", { roomCode: room.code });
          await Promise.all(room.bots.map((b) => emitAck(b, "player:ready", { roomCode: room.code, ready: true })));
        }
      }
    } catch (error) {
      state.setupErrors.push({ room: room.code || n, error: error.message });
    }
  }

  const ready = Promise.all(Array.from({ length: rooms }, (_, n) => sleep(n * 400).then(() => setUp(n))));
  // Resolves once every room either battles or failed its setup.
  state.untilBattling = async (timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const battling = state.rooms.filter((r) => r.battling).length;
      if (state.rooms.length === rooms && battling + state.setupErrors.length >= rooms) break;
      await sleep(500);
    }
    return state.rooms.filter((r) => r.battling).length;
  };
  state.stop = async () => {
    state.stopped = true;
    for (const room of state.rooms) for (const bot of room.bots) bot.socket?.disconnect();
    await Promise.race([ready, sleep(2_000)]);
  };
  return state;
}

// --- Measures and reports ------------------------------------------------------------------------------
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function machine() {
  return { platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30) };
}

export function writeReport(prefix, report) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(LOAD_TESTS, "reports");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${prefix}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  log(`Report: ${path.relative(REPO, file)}`);
  return file;
}
