// OBS-1 measure 3: an event can be traced through the three services with its correlation id.
//
// Usage (from load-tests/, after `npm install`; the stack starts if it is not running):
//   node scripts/obs-trace.mjs [--id obs1-trace-<timestamp>]
//
// With a known X-Correlation-Id (obs1-trace-<timestamp>), through the api-gateway: creates a room, gets
// a guest token, opens both Socket.IO handshakes, and plays up to a battle (song challenge, song
// choice). The battle finishes on its own at the end of the song (about 95 s); battle-service then
// stores the result with PUT /api/matches/{battleId} on users-service, sending the battle's
// correlation id. The script then searches `docker compose logs` of api-gateway, battle-1, battle-2
// and users-service for the id and lists every matching line (service, timestamp, message).
//
// Pass: the id appears in the gateway, in battle-service and in users-service, and the users-service
// line names the finished battle. Writes reports/obs-trace-<timestamp>.json.
import { compose, connectBot, emitAck, ensureStack, flag, log, mintEntraToken, option, post, sleep, waitFor, writeReport } from "../lib/obs-stack.mjs";

const ID = option("id", `obs1-trace-${Date.now()}`);
const SERVICES = ["api-gateway", "battle-1", "battle-2", "users-service"];

async function playBattle() {
  const room = { ip: "198.18.250.1", code: "", bots: [] };
  const host = { index: 0, id: `trace${Date.now().toString(36)}`, name: "Trace host", role: "dancer", token: "", socket: null };
  host.token = mintEntraToken({ oid: host.id, name: host.name });
  const created = await post("/api/rooms", { displayName: host.name }, { token: host.token, ip: room.ip, correlationId: ID });
  room.code = created.body.code;
  log(`Room ${room.code} created; the gateway echoed X-Correlation-Id ${created.correlationId}`);
  const guestBody = (await post(`/api/rooms/${room.code}/guest-token`, { displayName: "Trace guest" }, { ip: room.ip, correlationId: ID })).body;
  const guest = { index: 1, id: guestBody.playerId, name: "Trace guest", role: "dancer", token: guestBody.token, socket: null };
  room.bots.push(host, guest);

  for (const bot of room.bots) {
    await connectBot(room, bot, { correlationId: ID, reconnection: false });
    const joined = await emitAck(bot, "room:join", { roomCode: room.code, displayName: bot.name });
    if (!joined.ok) throw new Error(`room:join ${joined.code}`);
  }
  for (const bot of room.bots) {
    const r = await emitAck(bot, "role:select", { roomCode: room.code, role: "dancer" });
    if (!r.ok) throw new Error(`role:select ${r.code}`);
  }
  for (const bot of room.bots) {
    const r = await emitAck(bot, "player:ready", { roomCode: room.code, ready: true });
    if (!r.ok) throw new Error(`player:ready ${r.code}`);
  }
  const challenge = await emitAck(host, "song-challenge:start", { roomCode: room.code });
  const phrase = challenge.data?.songSelection?.challenge?.phrase;
  if (!challenge.ok || !phrase) throw new Error(`song-challenge:start ${challenge.code ?? "without phrase"}`);
  const submit = await emitAck(host, "song-challenge:submit", { roomCode: room.code, text: phrase });
  if (!submit.ok || submit.data?.outcome !== "accepted") throw new Error(`song-challenge:submit ${submit.code ?? submit.data?.outcome}`);
  const started = waitFor(host.socket, "battle:started", null, 20_000);
  const chosen = await emitAck(host, "song:choose", { roomCode: room.code, songId: "song-1" });
  if (!chosen.ok) throw new Error(`song:choose ${chosen.code}`);
  const battle = (await started).battle;
  log(`Battle ${battle.id} started (battle:start through the gateway); it finishes in ${Math.round((battle.endsInMs ?? 0) / 1000)} s...`);
  const finished = await waitFor(host.socket, "battle:finished", null, (battle.endsInMs ?? 95_000) + 30_000);
  log(`Battle ${finished.battle?.id ?? battle.id} finished.`);
  for (const bot of room.bots) bot.socket.disconnect();
  return { roomCode: room.code, battleId: battle.id, gatewayEchoedId: created.correlationId };
}

/** `docker compose logs` lines that contain the id, parsed: service, timestamp, message and the JSON fields. */
async function linesWithId() {
  const out = await compose(["logs", "--no-color", ...SERVICES]);
  const found = [];
  for (const raw of out.split(/\r?\n/)) {
    if (!raw.includes(ID)) continue;
    const bar = raw.indexOf("|");
    const service = raw.slice(0, bar).trim().replace(/-\d+$/, "");
    const body = raw.slice(bar + 1).trim();
    let json = null;
    try {
      json = JSON.parse(body.slice(body.indexOf("{")));
    } catch {
      json = null;
    }
    found.push({
      service,
      timestamp: json?.["@timestamp"] ?? json?.timestamp ?? null,
      message: json?.message ?? body.slice(0, 200),
      json: json !== null,
      fields: json ? pick(json) : null,
    });
  }
  return found.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

function pick(json) {
  const keep = ["correlationId", "event", "roomId", "battleId", "method", "route", "path", "status", "uri", "instance", "log.level", "level"];
  const out = {};
  for (const key of keep) if (json[key] !== undefined) out[key] = json[key];
  if (json.log?.level) out.level = json.log.level;
  if (json.http) out.http = json.http;
  if (json.url) out.url = json.url;
  return out;
}

async function main() {
  if (!flag("no-start")) await ensureStack();
  const startedAt = new Date().toISOString();
  log(`Correlation id: ${ID}`);
  const played = await playBattle();

  // users-service gets the result from the outbox right after the finish; give it a few seconds.
  let lines = [];
  const deadline = Date.now() + 60_000;
  for (;;) {
    lines = await linesWithId();
    const stored = lines.some((l) => l.service === "users-service" && JSON.stringify(l).includes(played.battleId));
    if (stored || Date.now() > deadline) break;
    await sleep(2_000);
  }
  const byService = (name) => lines.filter((l) => l.service === name);
  const gateway = byService("api-gateway");
  const battle = [...byService("battle-1"), ...byService("battle-2")];
  const users = byService("users-service");
  const usersLineNamesBattle = users.some((l) => JSON.stringify(l).includes(played.battleId));
  const report = {
    scenario: "OBS-1 trace: one correlation id through api-gateway, battle-service and users-service",
    startedAt,
    finishedAt: new Date().toISOString(),
    correlationId: ID,
    ...played,
    services: {
      "api-gateway": gateway.length,
      "battle-service": battle.length,
      "battle-1": byService("battle-1").length,
      "battle-2": byService("battle-2").length,
      "users-service": users.length,
    },
    usersServiceLineNamesBattle: usersLineNamesBattle,
    allLinesJson: lines.every((l) => l.json),
    pass: gateway.length > 0 && battle.length > 0 && users.length > 0 && usersLineNamesBattle,
    lines,
  };
  writeReport("obs-trace", report);
  for (const l of lines) log(`${l.service.padEnd(13)} ${l.timestamp}  ${l.message}`);
  log(`Trace ${report.pass ? "PASS" : "FAIL"}: gateway ${gateway.length}, battle-service ${battle.length}, users-service ${users.length} lines with ${ID}`);
  return report.pass;
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
