// Uso: node scripts/chart.mjs <estres-1-replica.json> <estres-2-replicas.json> <salida.svg>
// Gráfica SVG (sin dependencias) del p95 del chat contra los usuarios concurrentes durante la subida
// de la prueba de estrés, 1 réplica vs 2, con el límite de 300 ms y el máximo sostenido de cada una.
import { readFileSync, writeFileSync } from "node:fs";
import { analyzeStress, P95_LIMIT_MS } from "./stress-analysis.mjs";

const [oneFile, twoFile, outFile] = process.argv.slice(2);
if (!oneFile || !twoFile || !outFile) {
  console.error("Uso: node scripts/chart.mjs <estres-1-replica.json> <estres-2-replicas.json> <salida.svg>");
  process.exit(2);
}

/** Solo la subida: hasta el primer intervalo con el máximo de usuarios (después las salas van terminando). */
function rampOf(analysis) {
  const peak = analysis.peakUsers;
  const end = analysis.points.findIndex((p) => p.users === peak);
  return analysis.points.slice(0, end + 1);
}

const series = [
  { name: "1 réplica", file: oneFile, color: "#2563eb", dash: "" },
  { name: "2 réplicas", file: twoFile, color: "#ea580c", dash: "" },
].map((s) => {
  const analysis = analyzeStress(JSON.parse(readFileSync(s.file, "utf8")));
  return { ...s, analysis, points: rampOf(analysis) };
});

const W = 860;
const H = 460;
const M = { top: 56, right: 28, bottom: 64, left: 72 };
const iw = W - M.left - M.right;
const ih = H - M.top - M.bottom;
const maxUsers = Math.ceil(Math.max(...series.flatMap((s) => s.points.map((p) => p.users))) / 100) * 100;
const yMin = 1;
const yMax = 10_000;
const x = (users) => M.left + (users / maxUsers) * iw;
const y = (ms) => M.top + ih - ((Math.log10(Math.max(ms, yMin)) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin))) * ih;
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");

const parts = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="13">`);
parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
parts.push(`<text x="${M.left}" y="26" font-size="16" font-weight="600" fill="#111827">REN-1: p95 del chat según usuarios concurrentes (subida de la prueba de estrés)</text>`);
parts.push(`<text x="${M.left}" y="44" fill="#4b5563">Mismo límite por réplica (0,5 CPU); escala logarítmica en el eje vertical</text>`);

// Rejilla y ejes
for (const ms of [1, 10, 100, 1000, 10000]) {
  parts.push(`<line x1="${M.left}" x2="${M.left + iw}" y1="${y(ms)}" y2="${y(ms)}" stroke="#e5e7eb"/>`);
  parts.push(`<text x="${M.left - 8}" y="${y(ms) + 4}" text-anchor="end" fill="#4b5563">${ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`}</text>`);
}
for (let u = 0; u <= maxUsers; u += 100) {
  parts.push(`<line x1="${x(u)}" x2="${x(u)}" y1="${M.top}" y2="${M.top + ih}" stroke="#f3f4f6"/>`);
  parts.push(`<text x="${x(u)}" y="${M.top + ih + 18}" text-anchor="middle" fill="#4b5563">${u}</text>`);
}
parts.push(`<line x1="${M.left}" x2="${M.left + iw}" y1="${M.top + ih}" y2="${M.top + ih}" stroke="#9ca3af"/>`);
parts.push(`<text x="${M.left + iw / 2}" y="${H - 16}" text-anchor="middle" fill="#111827">Usuarios concurrentes</text>`);
parts.push(`<text transform="translate(18 ${M.top + ih / 2}) rotate(-90)" text-anchor="middle" fill="#111827">p95 chat (envío → difusión recibida)</text>`);

// Límite de 300 ms
parts.push(`<line x1="${M.left}" x2="${M.left + iw}" y1="${y(P95_LIMIT_MS)}" y2="${y(P95_LIMIT_MS)}" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="6 4"/>`);
parts.push(`<text x="${M.left + iw - 4}" y="${y(P95_LIMIT_MS) - 6}" text-anchor="end" fill="#dc2626">límite REN-1: ${P95_LIMIT_MS} ms</text>`);

// Series
for (const s of series) {
  const d = s.points.map((p, i) => `${i ? "L" : "M"}${x(p.users).toFixed(1)},${y(p.p95).toFixed(1)}`).join(" ");
  parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`);
  for (const p of s.points) parts.push(`<circle cx="${x(p.users).toFixed(1)}" cy="${y(p.p95).toFixed(1)}" r="2.6" fill="${s.color}"/>`);
  // Máximo sostenido
  const m = s.analysis.maxUsersOk;
  parts.push(`<line x1="${x(m)}" x2="${x(m)}" y1="${M.top}" y2="${M.top + ih}" stroke="${s.color}" stroke-dasharray="2 3"/>`);
}
// Etiquetas de los máximos, sin solaparse
series.forEach((s, i) => {
  const m = s.analysis.maxUsersOk;
  parts.push(`<text x="${x(m) + 6}" y="${M.top + 16 + i * 18}" fill="${s.color}" font-weight="600">${esc(s.name)}: ${m} usuarios sostenidos</text>`);
});

// Leyenda
series.forEach((s, i) => {
  const lx = M.left + 12 + i * 130;
  const ly = M.top + ih - 14;
  parts.push(`<rect x="${lx - 6}" y="${ly - 12}" width="122" height="20" fill="#ffffff" opacity="0.9"/>`);
  parts.push(`<line x1="${lx}" x2="${lx + 22}" y1="${ly - 2}" y2="${ly - 2}" stroke="${s.color}" stroke-width="2.5"/>`);
  parts.push(`<text x="${lx + 28}" y="${ly + 2}" fill="#111827">${esc(s.name)}</text>`);
});

const gain = series[0].analysis.maxUsersOk > 0 ? (series[1].analysis.maxUsersOk / series[0].analysis.maxUsersOk).toFixed(2) : "-";
parts.push(`<text x="${M.left + iw}" y="44" text-anchor="end" fill="#111827" font-weight="600">Ganancia: ×${gain.replace(".", ",")}</text>`);
parts.push("</svg>");
writeFileSync(outFile, parts.join("\n"));
console.log(`Gráfica escrita en ${outFile}`);
