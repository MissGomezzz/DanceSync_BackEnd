// SEG-2 (non-repudiation): end-to-end verification against docker-compose.observability.yml.
//
// Usage (from load-tests/, after `npm install`; the stack starts if it is not running):
//   node scripts/seg2-verify.mjs [--build] [--no-tamper]
//
// What it does, as "Cómo se verifica" asks:
//   1. Through the api-gateway, with known client addresses (X-Forwarded-For, the script plays the
//      platform ingress) and known browsers (User-Agent), it makes HTTP requests (create a room, read
//      it, one without a token, one to the admin API by a non-admin) and Socket.IO actions (handshake,
//      room:join, chat, role:select, a handshake with an expired token). Each one has its own
//      correlation id.
//   2. As the admin account (ADMIN_USER_OID), it polls GET /api/admin/audit/records?correlationId=...
//      until each action is there, and measures how long the attribution took (target: < 1 minute).
//   3. It checks the 5 fields of every record: user (the token's, or anonymous), IP, UTC date and time
//      of the server, region (GeoIP) and browser.
//   4. It verifies the chain (POST /api/admin/audit/verify): it must be intact.
//   5. Unless --no-tamper: it tries to UPDATE a record as the application's database user (refused by
//      the append-only trigger), then changes one bypassing the triggers (session_replication_role, as
//      a superuser could) and verifies again: the chain must name that record as ALTERED_RECORD.
//      The stack's database is a tmpfs: `docker compose -f docker-compose.observability.yml down` resets it.
//
// Writes reports/seg2-verify-<timestamp>.json and .md.
import { writeFileSync } from "node:fs";
import { io } from "socket.io-client";
import { compose, dockerSync, flag, GATEWAY, log, mintEntraToken, sleep, writeReport } from "../lib/obs-stack.mjs";

const RUN = Date.now().toString(36);
const ADMIN_OID = process.env.ADMIN_USER_OID ?? "00000000-0000-4000-8000-00000000ad01";
const ATTRIBUTION_TARGET_MS = 60_000;
const USER = { oid: `seg2-ana-${RUN}`, name: "Ana SEG-2" };
// A public address (a well-known resolver, used here only as a header value) so the GeoIP region is
// resolved; the attacker's is from the benchmark range 198.18.0.0/15, which no database locates.
const USER_IP = process.env.SEG2_USER_IP ?? "8.8.8.8";
const ATTACKER_IP = "198.18.77.66";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
const CURL = "curl/8.11.0";

const userToken = mintEntraToken({ oid: USER.oid, name: USER.name });
const adminToken = mintEntraToken({ oid: ADMIN_OID, name: "Admin SEG-2" });
let sequence = 0;
const nextId = () => `seg2-${RUN}-${++sequence}`;

/** One action whose audit record must be found. */
const actions = [];

async function http(method, url, { token, ip, userAgent, body } = {}) {
  const correlationId = nextId();
  const at = Date.now();
  const res = await fetch(`${GATEWAY}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-correlation-id": correlationId,
      ...(ip ? { "x-forwarded-for": ip } : {}),
      ...(userAgent ? { "user-agent": userAgent } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, correlationId, at };
}

function expect(description, response, expected) {
  actions.push({ description, correlationId: response.correlationId, at: response.at, status: response.status, expected });
  log(`${description}: HTTP ${response.status}`);
}

function connect({ token, ip, userAgent }) {
  const correlationId = nextId();
  const at = Date.now();
  const socket = io(GATEWAY, {
    path: "/socket.io",
    transports: ["websocket"],
    reconnection: false,
    timeout: 10_000,
    auth: { token },
    extraHeaders: { "x-forwarded-for": ip, "user-agent": userAgent, "x-correlation-id": correlationId },
  });
  const ready = new Promise((resolve) => {
    socket.on("connect", () => resolve({ ok: true }));
    socket.on("connect_error", (error) => resolve({ ok: false, code: error.message }));
  });
  return { socket, correlationId, at, ready };
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.timeout(10_000).emit(event, payload, (error, response) => {
      if (error) return resolve({ ok: false, code: "TIMEOUT" });
      resolve(response?.ok ? { ok: true, data: response.data } : { ok: false, code: response?.error?.code });
    });
  });
}

async function adminGet(url) {
  const res = await fetch(`${GATEWAY}${url}`, { headers: { authorization: `Bearer ${adminToken}`, "user-agent": "SEG2-Verify admin" } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
}

async function adminPost(url) {
  const res = await fetch(`${GATEWAY}${url}`, { method: "POST", headers: { authorization: `Bearer ${adminToken}` } });
  if (!res.ok) throw new Error(`POST ${url}: HTTP ${res.status}`);
  return res.json();
}

async function psql(sql, { allowFail = false } = {}) {
  return compose(["exec", "-T", "postgres", "psql", "-U", "dancesync", "-d", "dancesync", "-v", "ON_ERROR_STOP=1", "-tAc", sql], { allowFail });
}

/**
 * Starts the stack (idempotent) and waits until the gateway answers and the admin API reaches
 * users-service. (lib/obs-stack.mjs ensureStack polls /api/battles/health/ready through the gateway,
 * which the gateway keeps behind authentication; /api/battles/health is the public probe.)
 */
async function waitForStack() {
  log("Starting docker-compose.observability.yml (project obs1)...");
  dockerSync(["compose", "-p", "obs1", "-f", "docker-compose.observability.yml", "up", "-d", ...(flag("build") ? ["--build"] : []), "--wait", "--wait-timeout", "600"]);
  const deadline = Date.now() + 240_000;
  for (;;) {
    const battle = await fetch(`${GATEWAY}/api/battles/health`).then((r) => r.ok, () => false);
    const admin = await fetch(`${GATEWAY}/api/admin/session`, { headers: { authorization: `Bearer ${adminToken}` } }).then((r) => r.status, () => 0);
    if (battle && admin === 200) return;
    if (Date.now() > deadline) throw new Error(`The stack is not ready: battle-service ${battle}, admin API HTTP ${admin}`);
    await sleep(2_000);
  }
}

async function main() {
  await waitForStack();

  // --- 1. Actions through the gateway ----------------------------------------------------------------
  const created = await http("POST", "/api/rooms", { token: userToken, ip: USER_IP, userAgent: FIREFOX, body: { displayName: USER.name } });
  expect("HTTP: create a room (registered user)", created, { userId: USER.oid, ip: USER_IP, userAgent: FIREFOX, outcome: "ok", action: "POST /api/rooms" });
  const code = created.body?.code;
  if (!code) throw new Error(`The room was not created: HTTP ${created.status}`);

  const read = await http("GET", `/api/rooms/${code}`, { token: userToken, ip: USER_IP, userAgent: FIREFOX });
  expect("HTTP: read the room", read, { userId: USER.oid, ip: USER_IP, userAgent: FIREFOX, outcome: "ok" });

  const anonymous = await http("POST", "/api/rooms", { ip: ATTACKER_IP, userAgent: CURL, body: { displayName: "x" } });
  expect("HTTP: create a room without a token", anonymous, { userId: null, ip: ATTACKER_IP, userAgent: CURL, outcome: "rejected", code: "missing_token" });

  const notAdmin = await http("GET", "/api/admin/audit/records", { token: userToken, ip: USER_IP, userAgent: FIREFOX });
  expect("HTTP: a non-admin opens the admin API", notAdmin, { userId: USER.oid, ip: USER_IP, outcome: "rejected", code: "not_admin" });

  const ana = connect({ token: userToken, ip: USER_IP, userAgent: FIREFOX });
  const handshake = await ana.ready;
  if (!handshake.ok) throw new Error(`Handshake refused: ${handshake.code}`);
  actions.push({ description: "Socket.IO: handshake", correlationId: ana.correlationId, at: ana.at, expected: { userId: USER.oid, ip: USER_IP, userAgent: FIREFOX, outcome: "ok", action: "socket:handshake" } });
  for (const [event, payload, description] of [
    ["room:join", { roomCode: code, displayName: USER.name }, "Socket.IO: room:join"],
    ["chat:message", { roomCode: code, content: "hola SEG-2" }, "Socket.IO: chat:message"],
    ["role:select", { roomCode: code, role: "dancer" }, "Socket.IO: role:select"],
  ]) {
    const at = Date.now();
    const result = await emitAck(ana.socket, event, payload);
    log(`${description}: ${result.ok ? "ok" : result.code}`);
    actions.push({ description, correlationId: ana.correlationId, at, expected: { userId: USER.oid, ip: USER_IP, userAgent: FIREFOX, outcome: "ok", action: event } });
  }
  ana.socket.disconnect();

  const expired = connect({ token: mintEntraToken({ oid: USER.oid, name: USER.name, expiresInSeconds: -120 }), ip: ATTACKER_IP, userAgent: CURL });
  const refused = await expired.ready;
  log(`Socket.IO: handshake with an expired token: ${refused.ok ? "accepted?!" : refused.code}`);
  expired.socket.disconnect();
  actions.push({ description: "Socket.IO: handshake with an expired token", correlationId: expired.correlationId, at: expired.at, expected: { userId: null, ip: ATTACKER_IP, userAgent: CURL, outcome: "rejected", action: "socket:handshake", code: "expired_token" } });

  // --- 2 & 3. Attribution time and the 5 fields ------------------------------------------------------
  const results = [];
  for (const action of actions) {
    let found = null;
    let foundAt = null;
    while (!found && Date.now() - action.at < ATTRIBUTION_TARGET_MS * 2) {
      const page = await adminGet(`/api/admin/audit/records?correlationId=${encodeURIComponent(action.correlationId)}&limit=50`);
      found = page.records.find((r) =>
        (!action.expected.action || r.action === action.expected.action) && r.outcome === action.expected.outcome);
      foundAt = Date.now();
      if (!found) await sleep(250);
    }
    const checks = found ? fieldChecks(found, action) : { found: false };
    results.push({ ...action, record: found, attributionMs: found ? foundAt - action.at : null, checks });
    log(`${action.description}: ${found ? `record #${found.seq} after ${foundAt - action.at} ms` : "NOT FOUND"}`);
  }

  // --- 4. Chain verification ---------------------------------------------------------------------------
  const verification = await adminPost("/api/admin/audit/verify");
  log(`Chain: ${verification.valid ? "intact" : "BROKEN"} (${verification.checked} records, ${verification.durationMs} ms)`);

  // --- 5. Tampering ------------------------------------------------------------------------------------
  let tamper = null;
  if (!flag("no-tamper")) {
    const target = results.find((r) => r.record)?.record;
    const update = await psql(`UPDATE audit_log SET user_id = 'mallory' WHERE seq = ${target.seq}`, { allowFail: true });
    const deleteAttempt = await psql(`DELETE FROM audit_log WHERE seq = ${target.seq}`, { allowFail: true });
    await psql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE audit_log SET user_id = 'mallory' WHERE seq = ${target.seq}; COMMIT;`);
    const after = await adminPost("/api/admin/audit/verify");
    const tamperedAt = Date.now();
    // The admin's alerts screen: the security alert at once (this verification), and the Prometheus
    // rule once users-service's background verification publishes audit_chain_valid = 0.
    let securityAlert = null;
    let prometheusAlert = null;
    while ((!securityAlert || !prometheusAlert) && Date.now() - tamperedAt < 120_000) {
      const view = await adminGet("/api/admin/alerts");
      securityAlert ??= view.security.find((a) => a.name === "AuditChainBroken") ? Date.now() - tamperedAt : null;
      prometheusAlert ??= view.operational.find((a) => a.name === "AuditChainBroken" && a.state === "firing") ? Date.now() - tamperedAt : null;
      if (!securityAlert || !prometheusAlert) await sleep(1_000);
    }
    log(`Alerts screen: security alert after ${securityAlert} ms, Prometheus AuditChainBroken firing after ${prometheusAlert} ms`);
    tamper = {
      alertMs: { security: securityAlert, prometheus: prometheusAlert },
      target: target.seq,
      plainUpdateRefused: update === null,
      plainDeleteRefused: deleteAttempt === null,
      afterBypass: after,
      detected: !after.valid && after.firstBrokenSeq === target.seq && after.problem === "ALTERED_RECORD",
    };
    log(`Tampering: UPDATE refused=${tamper.plainUpdateRefused}, DELETE refused=${tamper.plainDeleteRefused}, bypass detected=${tamper.detected} (${after.problem} at #${after.firstBrokenSeq})`);
  }

  const found = results.filter((r) => r.record);
  const attribution = found.map((r) => r.attributionMs);
  const report = {
    scenario: "SEG-2 non-repudiation",
    at: new Date().toISOString(),
    gateway: GATEWAY,
    actions: results.length,
    recorded: found.length,
    allFiveFields: results.every((r) => r.checks.fiveFields),
    allAsExpected: results.every((r) => r.checks.asExpected),
    attributionMs: { max: Math.max(...attribution), avg: Math.round(attribution.reduce((a, b) => a + b, 0) / attribution.length), target: ATTRIBUTION_TARGET_MS },
    chainBeforeTamper: verification,
    tamper,
    results,
  };
  report.pass = report.recorded === report.actions && report.allFiveFields && report.allAsExpected
    && report.attributionMs.max < ATTRIBUTION_TARGET_MS && verification.valid && (tamper === null || (tamper.detected && tamper.plainUpdateRefused && tamper.plainDeleteRefused
      && tamper.alertMs.security !== null && tamper.alertMs.prometheus !== null));
  const file = writeReport("seg2-verify", report);
  writeFileSync(file.replace(/\.json$/, ".md"), markdown(report));
  log(report.pass ? "PASS" : "FAIL");
  process.exit(report.pass ? 0 : 1);
}

function fieldChecks(record, action) {
  const e = action.expected;
  const occurred = Date.parse(record.occurredAt);
  const fiveFields = {
    user: e.userId === null ? record.userKind === "anonymous" && record.userId === null : record.userId === e.userId,
    ip: record.ip === e.ip,
    dateTimeUtc: /Z$/.test(record.occurredAt) && Math.abs(occurred - action.at) < 5_000,
    region: typeof record.region === "string" && record.region.length > 0,
    browser: e.userAgent === undefined ? record.userAgent.length > 0 : record.userAgent === e.userAgent,
  };
  return {
    fiveFields: Object.values(fiveFields).every(Boolean),
    detail: fiveFields,
    asExpected: record.outcome === e.outcome && (!e.code || record.code === e.code) && record.correlationId === action.correlationId,
    chained: /^[0-9a-f]{64}$/.test(record.hash) && /^[0-9a-f]{64}$/.test(record.prevHash),
  };
}

function markdown(report) {
  const rows = report.results.map((r) =>
    `| ${r.description} | ${r.record ? `#${r.record.seq}` : "—"} | ${r.record?.userId ?? (r.record ? "anonymous" : "—")} | ${r.record?.ip ?? "—"} | ${r.record?.region ?? "—"} | ${r.record ? r.record.userAgent.slice(0, 28) : "—"} | ${r.record?.occurredAt ?? "—"} | ${r.record?.outcome ?? "—"} | ${r.attributionMs ?? "—"} ms | ${r.checks.fiveFields ? "sí" : "NO"} |`);
  return `# SEG-2: verificación de punta a punta

- Fecha: ${report.at}
- Resultado: **${report.pass ? "PASA" : "FALLA"}**
- Acciones: ${report.actions}, registradas: ${report.recorded}
- Los 5 campos en todos los registros: ${report.allFiveFields ? "sí" : "no"}
- Atribución (acción -> registro consultable por el admin): máx ${report.attributionMs.max} ms, promedio ${report.attributionMs.avg} ms (meta < ${report.attributionMs.target / 1000} s)
- Cadena antes de manipular: ${report.chainBeforeTamper.valid ? "íntegra" : "ROTA"} (${report.chainBeforeTamper.checked} registros, ${report.chainBeforeTamper.durationMs} ms)
${report.tamper ? `- Alerta en el panel del admin: de seguridad a los ${report.tamper.alertMs.security} ms; regla de Prometheus \`AuditChainBroken\` disparada a los ${report.tamper.alertMs.prometheus} ms (`audit_chain_valid` refleja la última verificación, aquí la pedida por el admin; Prometheus la lee cada 5 s)
- UPDATE como usuario de la aplicación: ${report.tamper.plainUpdateRefused ? "rechazado" : "ACEPTADO"}; DELETE: ${report.tamper.plainDeleteRefused ? "rechazado" : "ACEPTADO"}
- Registro #${report.tamper.target} modificado saltándose los triggers: ${report.tamper.detected ? `detectado (${report.tamper.afterBypass.problem} en #${report.tamper.afterBypass.firstBrokenSeq})` : "NO detectado"}` : "- Sin prueba de manipulación (--no-tamper)"}

| Acción | Registro | Usuario | IP | Región | Navegador | Fecha y hora (UTC) | Resultado | Atribución | 5 campos |
|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}
`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
