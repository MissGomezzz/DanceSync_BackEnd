// Uso: node scripts/abuse-compare.mjs <linea-base.json> <con-ataque.json> [otra-linea-base.json]
// SEG-3: "la latencia p95 de los demás usuarios no aumenta más de un 5 % durante el ataque".
// Compara el p95 de los usuarios normales de una corrida sin ataque (nominal) con el p95 de esos
// mismos usuarios dentro de la ventana del ataque (abuse). Con una segunda línea base, muestra
// también cuánto varía el p95 entre dos corridas sin ataque: el ruido normal de la medición.
import { readFileSync } from "node:fs";

const [baseFile, attackFile, base2File] = process.argv.slice(2);
if (!baseFile || !attackFile) {
  console.error("Uso: node scripts/abuse-compare.mjs <linea-base.json> <con-ataque.json> [otra-linea-base.json]");
  process.exit(2);
}
const LIMIT = 0.05;
const load = (f) => JSON.parse(readFileSync(f, "utf8")).aggregate?.summaries ?? {};
const base = load(baseFile);
const attack = load(attackFile);
const base2 = base2File ? load(base2File) : null;
const fmt = (n) => (n == null ? "-" : Number(n).toFixed(1));
const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : NaN);
const sign = (n) => (Number.isNaN(n) ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(1)} %`);

console.log("\n========== SEG-3: LATENCIA DE LOS USUARIOS NORMALES CON Y SIN ATAQUE ==========");
console.log("p95 en ms               línea base   durante el ataque   variación" + (base2 ? "   ruido entre líneas base" : ""));
let worst = -Infinity;
let noiseWorst = 0;
for (const [label, key] of [["chat", "chat_e2e_ms"], ["voto", "vote_e2e_ms"], ["acuse", "ack_ms"]]) {
  const b = base[`dancesync.${key}`]?.p95;
  const w = attack[`dancesync.attack_window.${key}`]?.p95;
  const change = pct(b, w);
  worst = Math.max(worst, Number.isNaN(change) ? -Infinity : change);
  let noise = "";
  if (base2) {
    const b2 = base2[`dancesync.${key}`]?.p95;
    const n = Math.abs(pct(b, b2));
    noiseWorst = Math.max(noiseWorst, Number.isNaN(n) ? 0 : n);
    noise = `   ${sign(pct(b, b2)).padStart(10)}`;
  }
  console.log(`${label.padEnd(24)}${fmt(b).padStart(10)}   ${fmt(w).padStart(17)}   ${sign(change).padStart(9)}${noise}`);
}
if (worst === -Infinity) {
  console.log("\nSin datos de la ventana del ataque: ¿el segundo archivo es una corrida de `abuse`?");
  process.exit(1);
}
const ok = worst <= LIMIT * 100;
console.log(`\nCriterio: el p95 no aumenta más de un ${LIMIT * 100} % -> ${ok ? "PASA" : "FALLA"} (peor variación ${sign(worst)})`);
if (base2) {
  console.log(`Ruido de la medición: el p95 de dos corridas sin ataque difiere hasta ${noiseWorst.toFixed(1)} %.`);
  if (!ok && worst <= noiseWorst) console.log("La variación con ataque está dentro del ruido normal entre corridas sin ataque.");
}
console.log("");
process.exit(ok ? 0 : 1);
