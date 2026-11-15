// Uso: node scripts/abuse-compare.mjs <linea-base.json> <con-ataque.json> [otra-linea-base.json] [--from 245] [--to 540]
//
// SEG-3: "la latencia p95 de los demás usuarios no aumenta más de un 5 % durante el ataque".
//
// Compara el MISMO tramo de cada prueba: de --from a --to segundos desde su inicio (por defecto
// 245-540 s, dentro del ataque de `abuse.yml`). Comparar el ataque contra la corrida completa
// estaría sesgado: el inicio de una corrida, con pocas salas, tiene latencias más bajas que su
// parte central, con todas las salas en batalla.
//
// Exacto: si los tres reportes traen `dancesync.window.*` (el bot ya lo registra en toda corrida),
// usa esos percentiles. Aproximado: si alguno no lo trae (reportes anteriores), estima el p95 del
// tramo en los TRES a partir de los resúmenes de 10 s de Artillery (media ponderada por número de
// muestras de los p95 de cada intervalo), con el mismo método para todos.
//
// Con una segunda línea base también muestra cuánto varía el p95 entre dos corridas sin ataque:
// el ruido normal de la medición, contra el que hay que leer el 5 %.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const [baseFile, attackFile, base2File] = files;
if (!baseFile || !attackFile) {
  console.error("Uso: node scripts/abuse-compare.mjs <linea-base.json> <con-ataque.json> [otra-linea-base.json] [--from 245] [--to 540]");
  process.exit(2);
}
const FROM_S = flag("from", 245);
const TO_S = flag("to", 540);
const LIMIT_PCT = 5;
const KEYS = [["chat", "chat_e2e_ms"], ["voto", "vote_e2e_ms"], ["acuse", "ack_ms"]];

const reports = { base: baseFile, attack: attackFile, ...(base2File ? { base2: base2File } : {}) };
const loaded = Object.fromEntries(Object.entries(reports).map(([k, f]) => [k, JSON.parse(readFileSync(f, "utf8"))]));
const exact = Object.values(loaded).every((r) => r.aggregate?.summaries?.["dancesync.window.chat_e2e_ms"]);

/** p95 del tramo, estimado con los resúmenes de 10 s: media de los p95 ponderada por muestras. */
function approxWindowP95(report, key) {
  const periods = report.intermediate ?? [];
  const start = Math.min(...periods.map((p) => p.firstMetricAt ?? Number(p.period)).filter(Number.isFinite));
  let weighted = 0;
  let count = 0;
  for (const p of periods) {
    const s = p.summaries?.[`dancesync.${key}`];
    if (!s) continue;
    const at = (Number(p.period) - start) / 1000;
    if (at < FROM_S || at + 10 > TO_S) continue;
    weighted += s.p95 * s.count;
    count += s.count;
  }
  return count > 0 ? { p95: weighted / count, count } : null;
}

function windowP95(report, key) {
  if (exact) {
    const s = report.aggregate.summaries[`dancesync.window.${key}`];
    return s ? { p95: s.p95, count: s.count } : null;
  }
  return approxWindowP95(report, key);
}

const fmt = (n) => (n == null ? "-" : Number(n).toFixed(1));
const change = (from, to) => (from > 0 ? ((to - from) / from) * 100 : NaN);
const signed = (n) => (Number.isNaN(n) ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(1)} %`);

console.log("\n========== SEG-3: LATENCIA DE LOS USUARIOS NORMALES CON Y SIN ATAQUE ==========");
console.log(`Tramo comparado: del segundo ${FROM_S} al ${TO_S} de cada prueba. Método: ${exact ? "exacto (dancesync.window.*)" : "APROXIMADO con los resúmenes de 10 s (el mismo para los tres reportes)"}`);
console.log("");
console.log(`p95 en ms        base A   ${base2File ? "base B   " : ""}con ataque   ataque vs base A${base2File ? "   ataque vs base B   base B vs base A (ruido)" : ""}`);

let worstVsA = -Infinity;
let worstVsBoth = -Infinity;
let noise = 0;
for (const [label, key] of KEYS) {
  const a = windowP95(loaded.base, key)?.p95;
  const w = windowP95(loaded.attack, key)?.p95;
  const b = base2File ? windowP95(loaded.base2, key)?.p95 : undefined;
  const vsA = change(a, w);
  worstVsA = Math.max(worstVsA, Number.isNaN(vsA) ? -Infinity : vsA);
  let line = `${label.padEnd(15)}${fmt(a).padStart(7)}   `;
  if (base2File) line += `${fmt(b).padStart(6)}   `;
  line += `${fmt(w).padStart(10)}   ${signed(vsA).padStart(15)}`;
  if (base2File) {
    const vsB = change(b, w);
    const ab = change(a, b);
    // Contra la peor de las dos líneas base: el ataque debe quedar por debajo de max(base) + 5 %.
    const vsWorstBase = change(Math.max(a, b), w);
    worstVsBoth = Math.max(worstVsBoth, Number.isNaN(vsWorstBase) ? -Infinity : vsWorstBase);
    noise = Math.max(noise, Math.abs(ab));
    line += `   ${signed(vsB).padStart(17)}   ${signed(ab).padStart(24)}`;
  }
  console.log(line);
}

if (worstVsA === -Infinity) {
  console.log("\nSin datos del tramo. ¿Los reportes cubren ese tramo? Ajusta --from / --to.");
  process.exit(1);
}

console.log("");
const passA = worstVsA <= LIMIT_PCT;
console.log(`Contra la base A: peor variación ${signed(worstVsA)} -> ${passA ? "PASA" : "FALLA"} (límite +${LIMIT_PCT} %)`);
if (base2File) {
  const passBoth = worstVsBoth <= LIMIT_PCT;
  console.log(`Contra la peor de las dos bases: peor variación ${signed(worstVsBoth)} -> ${passBoth ? "PASA" : "FALLA"} (límite +${LIMIT_PCT} %)`);
  console.log(`Ruido: sin ataque, el p95 de una corrida a otra varía hasta ${noise.toFixed(1)} %.`);
  if (noise > LIMIT_PCT) {
    console.log(`AVISO: el ruido entre corridas sin ataque (${noise.toFixed(1)} %) es mayor que el límite (${LIMIT_PCT} %): con una`);
    console.log("corrida de cada una, esta medición no puede confirmar ni descartar un efecto del 5 %.");
  }
}
console.log("");
