// Uso: node scripts/summary.mjs <reporte.json> [nominal|stress|smoke]
// Lee el JSON de Artillery y compara contra el criterio de REN-1:
//   p95 <= 300 ms, < 1 % de errores, sin pérdida ni duplicación de puntajes, un único ganador por ronda.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Uso: node scripts/summary.mjs <reporte.json> [nominal|stress|smoke]");
  process.exit(2);
}
const kind = process.argv[3] ?? (file.includes("stress") ? "stress" : "nominal");
const P95_LIMIT_MS = 300;
const ERROR_LIMIT = 0.01;
const ROOM_SIZE = 7;

const report = JSON.parse(readFileSync(file, "utf8"));
const agg = report.aggregate ?? {};
const counters = agg.counters ?? {};
const sums = agg.summaries ?? {};
const c = (name) => counters[`dancesync.${name}`] ?? 0;
const fmt = (n) => (n === undefined || n === null ? "-" : Number(n).toFixed(1));
const row = (label, s) =>
  s
    ? `${label.padEnd(34)} n=${String(s.count).padStart(7)}  p50=${fmt(s.median).padStart(7)}  p95=${fmt(s.p95).padStart(7)}  p99=${fmt(s.p99).padStart(7)}  max=${fmt(s.max).padStart(7)}`
    : `${label.padEnd(34)} (sin datos)`;

console.log("\n========== RESUMEN REN-1 ==========");
console.log(`Archivo: ${file}`);
const first = agg.firstMetricAt ?? agg.firstCounterAt;
const last = agg.lastMetricAt ?? agg.lastCounterAt;
if (first && last) console.log(`Duración: ${((last - first) / 1000).toFixed(0)} s`);
console.log(`Salas lanzadas: ${counters["vusers.created"] ?? 0}  completadas: ${counters["vusers.completed"] ?? 0}  fallidas: ${counters["vusers.failed"] ?? 0}`);
console.log(`Batallas completas: ${c("battles_completed")}  | rondas de Word Race vistas: ${c("word_rounds_seen")}\n`);

console.log("Latencia (ms, medida desde el cliente):");
console.log(row("chat enviado -> difusión recibida", sums["dancesync.chat_e2e_ms"]));
console.log(row("voto enviado -> estado recibido", sums["dancesync.vote_e2e_ms"]));
console.log(row("palabra ganadora -> fin de ronda", sums["dancesync.word_e2e_ms"]));
console.log(row("acuse de cualquier evento", sums["dancesync.ack_ms"]));
console.log(row("HTTP crear sala", sums["dancesync.http_create_room_ms"]));
console.log(row("HTTP token de invitado", sums["dancesync.guest_token_ms"]));

const sent = c("events_sent");
const errors = c("errors");
const errorRate = sent > 0 ? errors / sent : 0;
console.log(`\nEventos enviados: ${sent}  | eventos room:updated recibidos: ${c("room_updates_received")}`);
console.log(`Errores: ${errors} (${(errorRate * 100).toFixed(2)} %)  | rechazos de dominio esperados: ${c("domain_rejections")}`);
console.log(`Rondas con fin duplicado: ${c("duplicate_round_end")} | ganadores distintos: ${c("winner_mismatch")} | puntajes inconsistentes: ${c("score_mismatch")}`);

const checks = [];
for (const [name, key] of [["chat", "chat_e2e_ms"], ["voto", "vote_e2e_ms"]]) {
  const s = sums[`dancesync.${key}`];
  checks.push([`p95 ${name} <= ${P95_LIMIT_MS} ms`, s ? s.p95 <= P95_LIMIT_MS : false, s ? `${fmt(s.p95)} ms` : "sin datos"]);
}
checks.push([`errores < ${ERROR_LIMIT * 100} %`, sent > 0 && errorRate < ERROR_LIMIT, `${(errorRate * 100).toFixed(2)} %`]);
checks.push(["un único ganador por ronda", c("duplicate_round_end") === 0 && c("winner_mismatch") === 0, ""]);
checks.push(["sin puntajes duplicados ni perdidos", c("score_mismatch") === 0, ""]);

console.log("\nVeredicto:");
for (const [label, ok, detail] of checks) console.log(`  ${ok ? "PASA " : "FALLA"}  ${label} ${detail ? `(${detail})` : ""}`);

// Prueba de estrés: usuarios concurrentes vs p95 por intervalo de Artillery (cada ~10 s).
if (kind === "stress") {
  const inter = report.intermediate ?? [];
  let created = 0;
  let completed = 0;
  let maxOk = 0;
  let broken = false;
  console.log("\nEstrés (usuarios concurrentes vs p95 del chat por intervalo):");
  for (const p of inter) {
    created += p.counters?.["vusers.created"] ?? 0;
    completed += p.counters?.["vusers.completed"] ?? 0;
    const users = (created - completed) * ROOM_SIZE;
    const s = p.summaries?.["dancesync.chat_e2e_ms"];
    if (!s) continue;
    const ok = s.p95 <= P95_LIMIT_MS;
    if (!ok) broken = true;
    if (ok && !broken) maxOk = Math.max(maxOk, users);
    console.log(`  usuarios=${String(users).padStart(5)}  p95=${fmt(s.p95).padStart(8)} ms  ${ok ? "ok" : "SUPERA 300 ms"}`);
  }
  console.log(`\nMáximo de usuarios sostenido con p95 <= ${P95_LIMIT_MS} ms: ${maxOk}`);
}
console.log("");
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
