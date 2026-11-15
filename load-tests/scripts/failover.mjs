// DIS-1 failover verification (availability: fault tolerance and horizontal scaling).
//
// Usage (from load-tests/, after `npm install`):
//   node scripts/failover.mjs [--rooms 20] [--room-size 7] [--victim busiest|battle-1|battle-2] [--kill-after-s 25]
//                             [--no-start] [--keep-up] [--label name]
//
// 1. Starts docker-compose.scale.yml + docker-compose.failover.yml under its own project name
//    (FAILOVER_PROJECT, default dis1test) on remapped host ports (LB_PORT 18088, BATTLE_1_PORT 13001,
//    BATTLE_2_PORT 13002): Redis, 2 battle-service replicas, nginx, users-service and a throwaway PostgreSQL.
// 2. Plays `rooms` rooms of `room-size` users through the load balancer up to a running battle
//    (2 dancers + spectators): every spectator votes once, dancers race for every word, everyone chats.
//    Clients reconnect like the frontend (Socket.IO reconnection) and repeat room:join on reconnect.
// 3. `kill-after-s` seconds after the last battle started, snapshots every room and word race from
//    Redis and kills one replica with SIGKILL (docker kill), mid-battle: by default the one holding
//    more WebSocket connections at that moment (the worst case).
// 4. Measures, per client that lost its connection, the time from the kill until it received a room
//    event again; lets every battle finish; compares the rooms with the snapshot; and checks the
//    finished battles against the rows users-service stored in PostgreSQL.
// 5. Writes reports/failover-<label>-<timestamp>.json and .md, then removes the stack (--keep-up keeps it).
//
// "Intact" room (the scenario allows votes and words in progress to change, never to be lost or
// counted twice): the same battle finished normally at the end of the song with every player still
// seated, every vote of the snapshot is still there, no dancer has fewer words than in the snapshot,
// every won round is counted exactly once, and every word round opened and closed.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

const require = createRequire(import.meta.url);
const { mintEntraToken } = require("../lib/fake-entra.cjs");

// --- Settings ----------------------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const ROOMS = Number(opt("rooms", 20));
const ROOM_SIZE = Math.min(7, Math.max(2, Number(opt("room-size", 7))));
const VICTIM_OPTION = opt("victim", "busiest");
const KILL_AFTER_S = Number(opt("kill-after-s", 25));
const LABEL = opt("label", `${ROOMS * ROOM_SIZE}u`);
const START = !flag("no-start");
const KEEP_UP = flag("keep-up");
/** Where to save the replicas' logs before the stack is removed (diagnosis); nothing saved when absent. */
const LOGS_FILE = opt("logs", null);
const RECOVERY_BUDGET_MS = 30_000;
const ACK_TIMEOUT_MS = 10_000;
const CHAT_EVERY_MS = 5_000;

const PROJECT = process.env.FAILOVER_PROJECT ?? "dis1test";
const PORTS = {
  LB_PORT: process.env.LB_PORT ?? "18088",
  BATTLE_1_PORT: process.env.BATTLE_1_PORT ?? "13001",
  BATTLE_2_PORT: process.env.BATTLE_2_PORT ?? "13002",
};
const BASE = `http://localhost:${PORTS.LB_PORT}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOAD_TESTS = path.resolve(HERE, "..");
const REPO = path.resolve(LOAD_TESTS, "..");
const COMPOSE = [
  "compose",
  "-p",
  PROJECT,
  "-f",
  path.join(REPO, "docker-compose.scale.yml"),
  "-f",
  path.join(REPO, "docker-compose.failover.yml"),
];
const RUN = Math.random().toString(36).slice(2, 6);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);

function docker(dockerArgs, { timeout = 900_000, allowFail = false } = {}) {
  try {
    return execFileSync("docker", dockerArgs, {
      cwd: REPO,
      env: { ...process.env, ...PORTS },
      encoding: "utf8",
      timeout,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    if (allowFail) return null;
    throw new Error(`docker ${dockerArgs.slice(0, 6).join(" ")} failed: ${error.stderr ?? error.message}`);
  }
}
const compose = (...rest) => docker([...COMPOSE, ...rest]);

/**
 * docker while the bots are connected. Never execFileSync there: the bots share this event loop, and a
 * docker call that blocks it for seconds keeps every client from answering heartbeats, which makes the
 * live replica drop healthy clients and turns a slow `docker exec` into a fake outage.
 */
function dockerAsync(dockerArgs, { timeout = 120_000, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      dockerArgs,
      { cwd: REPO, env: { ...process.env, ...PORTS }, encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (allowFail) return resolve(null);
        reject(new Error(`docker ${dockerArgs.slice(0, 6).join(" ")} failed: ${stderr || error.message}`));
      },
    );
  });
}
const composeAsync = (...rest) => dockerAsync([...COMPOSE, ...rest]);

// --- Stack ---------------------------------------------------------------------------------------
async function startStack() {
  log(`Starting the stack (project ${PROJECT}, load balancer ${BASE}); the first build takes a few minutes...`);
  compose("up", "-d", "--build", "--wait", "--wait-timeout", "300");
  log("Waiting for users-service (its own PostgreSQL)...");
  const probe = "fetch('http://users-service:8081/actuator/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))";
  const deadline = Date.now() + 240_000;
  while (docker([...COMPOSE, "exec", "-T", "battle-2", "node", "-e", probe], { allowFail: true, timeout: 20_000 }) === null) {
    if (Date.now() > deadline) throw new Error("users-service did not become healthy");
    await sleep(3_000);
  }
  const ready = await fetch(`${BASE}/api/battles/health/ready`).catch(() => null);
  if (!ready?.ok) throw new Error(`The load balancer does not answer at ${BASE}`);
  log("Stack ready.");
}

function stopStack() {
  if (KEEP_UP) {
    log(`--keep-up: the stack keeps running (docker compose -p ${PROJECT} ... down -v to remove it).`);
    return;
  }
  if (LOGS_FILE) {
    writeFileSync(LOGS_FILE, docker([...COMPOSE, "logs", "--no-color", "--timestamps", "battle-1", "battle-2"], { allowFail: true }) ?? "");
    log(`Replica logs saved to ${LOGS_FILE}`);
  }
  log("Removing the stack...");
  docker([...COMPOSE, "down", "-v", "--remove-orphans"], { allowFail: true });
}

/** Established connections on port 3000 inside a replica's container (its WebSocket clients, through nginx). */
async function connectionsOf(service) {
  const count = String.raw`const fs=require('fs');let n=0;for(const f of ['/proc/net/tcp','/proc/net/tcp6']){try{for(const l of fs.readFileSync(f,'utf8').split('\n').slice(1)){const p=l.trim().split(/\s+/);if(p[1]&&p[1].endsWith(':0BB8')&&p[3]==='01')n++}}catch{}}console.log(n)`;
  const out = await dockerAsync([...COMPOSE, "exec", "-T", service, "node", "-e", count], { allowFail: true, timeout: 20_000 });
  return out === null ? null : Number(out.trim());
}

// --- Bots ----------------------------------------------------------------------------------------
const rooms = [];
let killAt = 0;

function emitAck(bot, event, payload) {
  return new Promise((resolve) => {
    bot.socket.timeout(ACK_TIMEOUT_MS).emit(event, payload, (error, response) => {
      if (error) return resolve({ ok: false, code: "TIMEOUT" });
      if (response?.ok === false) return resolve({ ok: false, code: response.error?.code ?? "ERROR" });
      resolve({ ok: true, data: response?.data });
    });
  });
}

function waitFor(socket, event, predicate, timeoutMs) {
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

async function http(room, method, url, body, token) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": room.ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (response.status !== 201) throw new Error(`${method} ${url}: HTTP ${response.status}`);
  return response.json();
}

function connect(room, bot) {
  return new Promise((resolve, reject) => {
    // Like the frontend: Socket.IO reconnection with its default backoff, WebSocket only (ADR-02).
    const socket = io(BASE, {
      path: "/socket.io",
      transports: ["websocket"],
      reconnection: true,
      timeout: 10_000,
      auth: { token: bot.token },
      extraHeaders: { "x-forwarded-for": room.ip },
    });
    bot.socket = socket;
    let first = true;
    socket.on("connect", () => {
      if (first) {
        first = false;
        resolve();
        return;
      }
      void rejoin(room, bot);
    });
    socket.on("connect_error", (error) => {
      if (first) reject(new Error(`connect: ${error.message}`));
      else bot.reconnectErrors += 1;
    });
    socket.on("disconnect", (reason) => {
      if (room.closing) return;
      bot.disconnects.push({ at: Date.now(), reason });
      bot.pendingRecovery = { disconnectAt: Date.now(), reconnectAt: null };
    });
    socket.onAny(() => {
      const pending = bot.pendingRecovery;
      if (!pending || pending.reconnectAt === null) return;
      bot.pendingRecovery = null;
      bot.recoveries.push({ ...pending, firstEventAt: Date.now() });
    });
    listen(room, bot);
  });
}

/** After a reconnection the client repeats room:join (idempotent), as the frontend does. */
async function rejoin(room, bot) {
  if (bot.pendingRecovery) bot.pendingRecovery.reconnectAt = Date.now();
  const joined = await emitAck(bot, "room:join", { roomCode: room.code, displayName: bot.name });
  if (!joined.ok) bot.rejoinFailures.push(joined.code);
}

function listen(room, bot) {
  const { socket } = bot;
  socket.on("battle:started", (dto) => {
    room.battleId ??= dto.battle?.id;
    room.battleStartedAt ??= Date.now();
    room.endsAt ??= Date.now() + (dto.battle?.endsInMs ?? 95_000);
    if (bot.role === "spectator" && !bot.voted) {
      bot.voted = true;
      setTimeout(() => void vote(room, bot), Math.max(0, dto.battle?.startsInMs ?? 0) + 300 + Math.random() * 2_000);
    }
  });
  socket.on("word:round-started", (round) => {
    bot.started.set(round.roundId, (bot.started.get(round.roundId) ?? 0) + 1);
    room.totalRounds = round.totalRounds;
    if (bot.role !== "dancer") return;
    setTimeout(async () => {
      const r = await emitAck(bot, "word:submit", { roomCode: room.code, roundId: round.roundId, text: round.word });
      if (r.ok && r.data?.outcome === "won") room.claimsWon.add(round.roundId);
    }, Math.random() * 150);
  });
  socket.on("word:round-ended", (end) => {
    bot.ended.set(end.roundId, (bot.ended.get(end.roundId) ?? 0) + 1);
    room.totalRounds = end.totalRounds;
    room.roundsEnded.set(end.roundId, end.reason === "won" ? end.winnerId : null);
  });
  socket.on("battle:finished", (dto) => {
    room.finishedBattleId ??= dto.battle?.id;
    room.finishedAt ??= Date.now();
  });
}

async function vote(room, bot) {
  const dancer = room.bots[Math.floor(Math.random() * 2)];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await emitAck(bot, "vote:cast", { roomCode: room.code, dancerId: dancer.id });
    if (r.ok) {
      room.votes.set(bot.id, dancer.id);
      return;
    }
    await sleep(1_000);
  }
  bot.voteFailed = true;
}

async function chatLoop(room, bot) {
  await sleep(Math.random() * CHAT_EVERY_MS);
  let n = 0;
  while (!room.closing) {
    if (bot.socket.connected) {
      const r = await emitAck(bot, "chat:message", { roomCode: room.code, content: `m${bot.index}-${n++}` });
      if (!r.ok) room.chatFailures += 1;
    }
    await sleep(CHAT_EVERY_MS * (0.75 + Math.random() * 0.5));
  }
}

async function setUpRoom(n) {
  const room = {
    n,
    ip: `198.18.${Math.floor(n / 250)}.${(n % 250) + 1}`,
    code: "",
    bots: [],
    closing: false,
    battleId: null,
    battleStartedAt: null,
    endsAt: null,
    finishedBattleId: null,
    finishedAt: null,
    totalRounds: null,
    roundsEnded: new Map(),
    claimsWon: new Set(),
    votes: new Map(),
    chatFailures: 0,
    error: null,
  };
  rooms.push(room);
  for (let i = 0; i < ROOM_SIZE; i += 1) {
    room.bots.push({
      index: i,
      id: i === 0 ? `F${RUN}r${n}host` : "",
      name: `Bot ${n}-${i}`,
      role: i < 2 ? "dancer" : "spectator",
      token: "",
      socket: null,
      disconnects: [],
      recoveries: [],
      pendingRecovery: null,
      rejoinFailures: [],
      reconnectErrors: 0,
      started: new Map(),
      ended: new Map(),
      voted: false,
      voteFailed: false,
    });
  }
  try {
    const host = room.bots[0];
    host.token = mintEntraToken({ oid: host.id, name: host.name });
    room.code = (await http(room, "POST", "/api/rooms", { displayName: host.name }, host.token)).code;
    for (const bot of room.bots) {
      if (bot.index > 0) {
        const guest = await http(room, "POST", `/api/rooms/${room.code}/guest-token`, { displayName: bot.name });
        bot.token = guest.token;
        bot.id = guest.playerId;
      }
      await connect(room, bot);
      const joined = await emitAck(bot, "room:join", { roomCode: room.code, displayName: bot.name });
      if (!joined.ok) throw new Error(`room:join ${joined.code}`);
    }
    for (const bot of room.bots) {
      const r = await emitAck(bot, "role:select", { roomCode: room.code, role: bot.role });
      if (!r.ok) throw new Error(`role:select ${r.code}`);
    }
    for (const bot of room.bots) {
      const r = await emitAck(bot, "player:ready", { roomCode: room.code, ready: true });
      if (!r.ok) throw new Error(`player:ready ${r.code}`);
    }
    const challenge = await emitAck(host, "song-challenge:start", { roomCode: room.code });
    const phrase = challenge.data?.songSelection?.challenge?.phrase;
    if (!challenge.ok || !phrase) throw new Error(`song-challenge:start ${challenge.code ?? "without phrase"}`);
    const dancers = room.bots.filter((b) => b.role === "dancer");
    const answers = await Promise.all(
      dancers.map(async (d) => ({ d, r: await emitAck(d, "song-challenge:submit", { roomCode: room.code, text: phrase }) })),
    );
    const winner = answers.find((a) => a.r.ok && a.r.data?.outcome === "accepted");
    if (!winner) throw new Error("nobody won the song challenge");
    const started = waitFor(host.socket, "battle:started", null, 20_000);
    const chosen = await emitAck(winner.d, "song:choose", { roomCode: room.code, songId: "song-1" });
    if (!chosen.ok) throw new Error(`song:choose ${chosen.code}`);
    await started;
    for (const bot of room.bots) void chatLoop(room, bot);
  } catch (error) {
    room.error = error.message;
    log(`Room ${room.code || n}: ${error.message}`);
  }
}

// --- Redis snapshots and PostgreSQL ------------------------------------------------------------
async function snapshot(codes) {
  if (codes.length === 0) return new Map();
  const script =
    'for c in "$@"; do echo "@@ROOM $c"; redis-cli --raw HGET "room:{$c}" data; echo "@@RACE $c"; redis-cli --raw HGETALL "wordrace:{$c}"; done';
  const out = await composeAsync("exec", "-T", "redis", "sh", "-c", script, "sh", ...codes);
  const result = new Map();
  let current = null;
  let mode = null;
  let raceLines = [];
  const flush = () => {
    if (current && mode === "race") current.race = parseRace(raceLines);
    raceLines = [];
  };
  for (const line of out.split(/\r?\n/)) {
    const marker = line.match(/^@@(ROOM|RACE) (\S+)$/);
    if (marker) {
      flush();
      const code = marker[2];
      if (!result.has(code)) result.set(code, { room: null, race: null });
      current = result.get(code);
      mode = marker[1] === "ROOM" ? "room" : "race";
      continue;
    }
    if (mode === "room" && current && line.trim() !== "") {
      current.room = JSON.parse(line);
      mode = null;
    } else if (mode === "race") raceLines.push(line);
  }
  flush();
  return result;
}

function parseRace(lines) {
  const fields = {};
  const clean = lines.filter((l) => l !== "");
  for (let i = 0; i + 1 < clean.length; i += 2) fields[clean[i]] = clean[i + 1];
  if (!fields.meta) return null;
  const meta = JSON.parse(fields.meta);
  return {
    battleId: meta.battleId,
    rounds: meta.rounds.map((r) => ({ id: r.id, status: fields[`s:${r.id}`], winnerId: fields[`w:${r.id}`] ?? null })),
  };
}

async function psql(sql) {
  return (await composeAsync("exec", "-T", "failover-postgres", "psql", "-U", "dancesync", "-d", "dancesync", "-At", "-F", "|", "-c", sql))
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
}

// --- Measures --------------------------------------------------------------------------------------
const sum = (values) => values.reduce((a, b) => a + b, 0);
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function judgeRoom(room, before, after) {
  const checks = {};
  const b = before?.room?.battle;
  const a = after?.room?.battle;
  checks.sameBattleFinishedAtSongEnd =
    after?.room?.status === "finished" && a?.id === b?.id && a?.endReason === "song-end" && room.finishedBattleId === b?.id;
  checks.everyPlayerStillSeated = (after?.room?.players?.length ?? 0) === (before?.room?.players?.length ?? -1);
  checks.votesKept = Object.entries(b?.votes ?? {}).every(([voter, dancer]) => a?.votes?.[voter] === dancer);
  const awardedBefore = b?.wordRoundsAwarded ?? [];
  const awardedAfter = a?.wordRoundsAwarded ?? [];
  const wonInRaceBefore = (before?.race?.rounds ?? []).filter((r) => r.status === "won").map((r) => r.id);
  checks.noWordLost =
    Object.entries(b?.wordsWon ?? {}).every(([dancer, won]) => (a?.wordsWon?.[dancer] ?? 0) >= won) &&
    awardedBefore.every((id) => awardedAfter.includes(id)) &&
    wonInRaceBefore.every((id) => awardedAfter.includes(id)) &&
    [...room.roundsEnded.entries()].filter(([, winner]) => winner).every(([id]) => awardedAfter.includes(id));
  const wordsCounted = sum(Object.values(a?.wordsWon ?? {}));
  checks.noWordCountedTwice = wordsCounted === awardedAfter.length && new Set(awardedAfter).size === awardedAfter.length;
  checks.noDuplicateRoundEvent = room.bots.every((bot) => [...bot.ended.values()].every((count) => count <= 1));
  checks.everyRoundOpenedAndClosed = room.totalRounds !== null && room.roundsEnded.size === room.totalRounds;
  return { intact: Object.values(checks).every(Boolean), checks };
}

// --- Main --------------------------------------------------------------------------------------------
async function main() {
  const startedAt = new Date();
  // Health of the load generator itself: a blocked event loop delays every client, not the server.
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  if (START) await startStack();

  loopDelay.enable();
  log(`Setting up ${ROOMS} rooms of ${ROOM_SIZE} users (${ROOMS * ROOM_SIZE} users) through ${BASE}...`);
  await Promise.all(Array.from({ length: ROOMS }, (_, n) => sleep(n * 250).then(() => setUpRoom(n))));
  const battling = rooms.filter((r) => !r.error && r.battleId);
  log(`${battling.length}/${ROOMS} rooms battling (${battling.length * ROOM_SIZE} users).`);
  if (battling.length === 0) throw new Error("No room reached a battle");

  await sleep(KILL_AFTER_S * 1000);
  const codes = battling.map((r) => r.code);
  const before = await snapshot(codes);
  const roundsPendingAtKill = sum(
    codes.map((c) => (before.get(c)?.race?.rounds ?? []).filter((r) => r.status === "scheduled" || r.status === "open").length),
  );
  const connections = { "battle-1": await connectionsOf("battle-1"), "battle-2": await connectionsOf("battle-2") };
  const VICTIM =
    VICTIM_OPTION === "busiest" ? ((connections["battle-1"] ?? 0) >= (connections["battle-2"] ?? 0) ? "battle-1" : "battle-2") : VICTIM_OPTION;
  log(`Connections per replica: ${JSON.stringify(connections)}.`);
  log(`Snapshot taken: ${roundsPendingAtKill} word rounds still pending. Killing ${VICTIM} (SIGKILL)...`);
  killAt = Date.now();
  await composeAsync("kill", "-s", "SIGKILL", VICTIM);

  // Recovery: every client that lost its connection receives a room event again.
  const affected = () => battling.flatMap((r) => r.bots).filter((b) => b.disconnects.some((d) => d.at >= killAt));
  await sleep(2_000);
  const recoveryDeadline = killAt + 90_000;
  while (Date.now() < recoveryDeadline && affected().some((b) => b.pendingRecovery)) await sleep(250);
  const affectedBots = affected();
  const recoveries = affectedBots.map((b) => b.recoveries.find((r) => r.disconnectAt >= killAt)).filter(Boolean);
  const recoveryMs = recoveries.map((r) => r.firstEventAt - killAt);
  log(`${affectedBots.length} clients lost their connection; ${recoveries.length} received room events again.`);

  // Every battle runs to the end of its song.
  const finishDeadline = Math.max(...battling.map((r) => r.endsAt ?? 0)) + 30_000;
  while (Date.now() < finishDeadline && battling.some((r) => !r.finishedBattleId)) await sleep(500);
  await sleep(1_000);
  for (const room of rooms) room.closing = true;
  const after = await snapshot(codes);
  const judged = battling.map((room) => ({ room, ...judgeRoom(room, before.get(room.code), after.get(room.code)) }));
  log(`${judged.filter((j) => j.intact).length}/${judged.length} rooms intact.`);

  // Match history: every finished battle in PostgreSQL, once, with the room's final numbers.
  // The battle each room finished, as stored in Redis (also when no client was there to see battle:finished).
  const finishedIdOf = (room) => {
    const stored = after.get(room.code)?.room;
    return stored?.status === "finished" ? (stored.battle?.id ?? null) : room.finishedBattleId;
  };
  const finishedIds = battling.map(finishedIdOf).filter(Boolean);
  let rows = [];
  const historyDeadline = Date.now() + 120_000;
  while (Date.now() < historyDeadline) {
    rows = await psql("select id::text from matches");
    if (finishedIds.every((id) => rows.includes(id))) break;
    await sleep(3_000);
  }
  const participantRows = await psql(
    "select match_id::text, player_id, coalesce(votes, -1), coalesce(words_won, -1) from match_participants where role = 'dancer'",
  );
  const persisted = new Map(participantRows.map((line) => {
    const [matchId, playerId, votes, wordsWon] = line.split("|");
    return [`${matchId}/${playerId}`, { votes: Number(votes), wordsWon: Number(wordsWon) }];
  }));
  const scoreMismatches = [];
  for (const room of battling) {
    const standings = after.get(room.code)?.room?.battle?.result?.standings ?? [];
    for (const s of standings) {
      const stored = persisted.get(`${finishedIdOf(room)}/${s.dancerId}`);
      if (!stored || stored.votes !== s.votes || stored.wordsWon !== s.wordsWon) scoreMismatches.push({ room: room.code, dancer: s.dancerId });
    }
  }
  const lost = finishedIds.filter((id) => !rows.includes(id));
  const duplicates = rows.length - new Set(rows).size;

  for (const room of rooms) for (const bot of room.bots) bot.socket?.disconnect();

  const users = battling.length * ROOM_SIZE;
  const maxRecovery = recoveryMs.length ? Math.max(...recoveryMs) : null;
  const report = {
    scenario: "DIS-1 failover: one of two battle-service replicas killed mid-battle",
    label: LABEL,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    setup: {
      roomsRequested: ROOMS,
      roomSize: ROOM_SIZE,
      roomsBattling: battling.length,
      usersBattling: users,
      roomSetupErrors: rooms.filter((r) => r.error).map((r) => ({ room: r.code || r.n, error: r.error })),
      victim: VICTIM,
      connectionsPerReplicaAtKill: connections,
      killedSecondsAfterLastBattleStart: Math.round((killAt - Math.max(...battling.map((r) => r.battleStartedAt))) / 1000),
      wordRoundsPendingAtKill: roundsPendingAtKill,
      loadBalancer: "nginx OSS, least_conn, passive checks (max_fails=1 fail_timeout=10s, proxy_connect_timeout 2s)",
      clientReconnection: "socket.io-client defaults (1 s delay, x0.5 jitter, 5 s max), WebSocket only",
      generatorEventLoopDelayMaxMs: Math.round(loopDelay.max / 1e6),
      machine: { platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30) },
    },
    recovery: {
      clientsDisconnected: affectedBots.length,
      clientsRecovered: recoveries.length,
      clientsNotRecovered: affectedBots.length - recoveries.length,
      rejoinFailures: sum(affectedBots.map((b) => b.rejoinFailures.length)),
      rejoinFailureCodes: affectedBots.flatMap((b) => b.rejoinFailures),
      // "transport close": the replica's connection dropped; "ping timeout": a heartbeat went unanswered.
      disconnectReasons: affectedBots
        .flatMap((b) => b.disconnects.filter((d) => d.at >= killAt).map((d) => d.reason))
        .reduce((counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }), {}),
      disconnectsBeforeKill: battling
        .flatMap((r) => r.bots.flatMap((b) => b.disconnects.filter((d) => d.at < killAt).map((d) => ({ room: r.code, bot: b.index, reason: d.reason, secondsBeforeKill: Math.round((killAt - d.at) / 1000) }))))
        .slice(0, 50),
      clientsDisconnectedMoreThanOnce: affectedBots.filter((b) => b.disconnects.filter((d) => d.at >= killAt).length > 1).length,
      maxMs: maxRecovery,
      p95Ms: percentile(recoveryMs, 95),
      p50Ms: percentile(recoveryMs, 50),
      meetsBudget: maxRecovery !== null && maxRecovery < RECOVERY_BUDGET_MS && recoveries.length === affectedBots.length,
      budgetMs: RECOVERY_BUDGET_MS,
    },
    state: {
      roomsIntact: judged.filter((j) => j.intact).length,
      roomsChecked: judged.length,
      percentIntact: judged.length ? Math.round((judged.filter((j) => j.intact).length / judged.length) * 1000) / 10 : null,
      meetsTarget: judged.length > 0 && judged.filter((j) => j.intact).length / judged.length >= 0.95,
      failedChecks: judged
        .filter((j) => !j.intact)
        .map((j) => ({ room: j.room.code, failed: Object.entries(j.checks).filter(([, ok]) => !ok).map(([name]) => name) })),
      duplicateRoundEndEvents: sum(battling.flatMap((r) => r.bots.flatMap((b) => [...b.ended.values()].map((c) => Math.max(0, c - 1))))),
      chatFailures: sum(battling.map((r) => r.chatFailures)),
      votesFailed: battling.flatMap((r) => r.bots).filter((b) => b.voteFailed).length,
    },
    results: {
      battlesFinished: finishedIds.length,
      rowsInPostgres: finishedIds.filter((id) => rows.includes(id)).length,
      lost: lost.length,
      lostIds: lost,
      duplicates,
      persistedScoreMismatches: scoreMismatches,
      meetsTarget: lost.length === 0 && duplicates === 0 && scoreMismatches.length === 0,
    },
  };

  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.join(LOAD_TESTS, "reports");
  mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `failover-${LABEL}-${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${base}.md`, markdown(report));
  log(`Report: ${path.relative(REPO, base)}.json / .md`);
  console.log(markdown(report));
  return report;
}

function markdown(r) {
  const yes = (ok) => (ok ? "PASS" : "FAIL");
  return `# DIS-1 failover run: ${r.label}

${r.scenario}. Started ${r.startedAt}.

| Setup | Value |
|---|---|
| Rooms battling / requested | ${r.setup.roomsBattling} / ${r.setup.roomsRequested} (${r.setup.roomSize} users each) |
| Users in battle | ${r.setup.usersBattling} |
| Replica killed (SIGKILL) | ${r.setup.victim}, ${r.setup.killedSecondsAfterLastBattleStart} s after the last battle started |
| Connections per replica at the kill | ${Object.entries(r.setup.connectionsPerReplicaAtKill).map(([k, v]) => `${k}: ${v}`).join(", ")} |
| Word rounds still pending at the kill | ${r.setup.wordRoundsPendingAtKill} |
| Load balancer | ${r.setup.loadBalancer} |
| Clients | ${r.setup.clientReconnection} |
| Machine | ${r.setup.machine.platform}, ${r.setup.machine.cpus} CPUs, ${r.setup.machine.memoryGb} GB |
| Load generator: worst event loop delay | ${r.setup.generatorEventLoopDelayMaxMs} ms (all bots run in one process; a large value delays every client) |

| Measure | Target | Result | Verdict |
|---|---|---|---|
| Service restored (kill -> every disconnected client receives room events again) | < 30 s | max ${r.recovery.maxMs} ms, p95 ${r.recovery.p95Ms} ms, p50 ${r.recovery.p50Ms} ms; ${r.recovery.clientsRecovered}/${r.recovery.clientsDisconnected} clients | ${yes(r.recovery.meetsBudget)} |
| Rooms with state and scores intact | >= 95 % | ${r.state.roomsIntact}/${r.state.roomsChecked} (${r.state.percentIntact} %) | ${yes(r.state.meetsTarget)} |
| Finished-match results lost | 0 | ${r.results.lost} of ${r.results.battlesFinished} (${r.results.rowsInPostgres} rows in PostgreSQL) | ${yes(r.results.lost === 0)} |
| Duplicated results / scores | 0 | ${r.results.duplicates} duplicated rows, ${r.results.persistedScoreMismatches.length} persisted scores different from the room, ${r.state.duplicateRoundEndEvents} duplicated round-end events | ${yes(r.results.duplicates === 0 && r.results.persistedScoreMismatches.length === 0 && r.state.duplicateRoundEndEvents === 0)} |

Other observations: ${r.recovery.rejoinFailures} failed rejoins, ${r.state.chatFailures} failed chat messages (sent while disconnected or refused), ${r.state.votesFailed} votes that could not be cast, ${r.setup.roomSetupErrors.length} rooms that failed during setup.
${r.state.failedChecks.length ? `\nRooms not intact:\n${r.state.failedChecks.map((f) => `- ${f.room}: ${f.failed.join(", ")}`).join("\n")}\n` : ""}`;
}

let exitCode = 0;
try {
  const report = await main();
  exitCode = report.recovery.meetsBudget && report.state.meetsTarget && report.results.meetsTarget ? 0 : 1;
} catch (error) {
  console.error(error);
  exitCode = 2;
} finally {
  for (const room of rooms) {
    room.closing = true;
    for (const bot of room.bots) bot.socket?.disconnect();
  }
  if (START) stopStack();
}
process.exit(exitCode);
