// Uso: node scripts/compare.mjs <estres-1-replica.json> <estres-2-replicas.json>
// Evidencia de escalabilidad horizontal (REN-1): máximo de usuarios sostenido con p95 <= 300 ms, 1 réplica vs 2.
import { readFileSync } from "node:fs";
import { analyzeStress, P95_LIMIT_MS } from "./stress-analysis.mjs";

const [oneFile, twoFile] = process.argv.slice(2);
if (!oneFile || !twoFile) {
  console.error("Uso: node scripts/compare.mjs <estres-1-replica.json> <estres-2-replicas.json>");
  process.exit(2);
}
const reports = [oneFile, twoFile].map((file) => JSON.parse(readFileSync(file, "utf8")));
const metaOf = (file) => {
  try {
    return JSON.parse(readFileSync(file.replace(/\.json$/, ".meta.json"), "utf8"));
  } catch {
    return null;
  }
};
const windowOf = (report) => [report.aggregate?.firstCounterAt ?? report.aggregate?.firstMetricAt, report.aggregate?.lastCounterAt ?? report.aggregate?.lastMetricAt];

// Validez de la comparación: no se pueden haber corrido a la vez, y cada una con su número de réplicas.
const [[start1, end1], [start2, end2]] = reports.map(windowOf);
if (start1 && start2 && start1 < end2 && start2 < end1) {
  console.error("\nCOMPARACIÓN INVÁLIDA: las dos pruebas se ejecutaron al mismo tiempo en la misma máquina.");
  console.error(`  1 réplica:  ${new Date(start1).toISOString()} -> ${new Date(end1).toISOString()}`);
  console.error(`  2 réplicas: ${new Date(start2).toISOString()} -> ${new Date(end2).toISOString()}`);
  console.error("Repite las pruebas una después de la otra.\n");
  process.exit(1);
}
const [meta1, meta2] = [metaOf(oneFile), metaOf(twoFile)];
if (meta1?.replicas != null && meta1.replicas !== 1) console.log(`AVISO: el primer archivo se corrió con ${meta1.replicas} réplicas con tráfico, no con 1.`);
if (meta2?.replicas != null && meta2.replicas !== 2) console.log(`AVISO: el segundo archivo se corrió con ${meta2.replicas} réplicas con tráfico, no con 2.`);
if (meta1?.cpusPerReplica != null && meta2?.cpusPerReplica != null && meta1.cpusPerReplica !== meta2.cpusPerReplica) {
  console.log("AVISO: las réplicas tenían distinto límite de CPU en cada prueba; la comparación no es justa.");
}

const one = analyzeStress(reports[0]);
const two = analyzeStress(reports[1]);

const cell = (a) => (a.reachedLimit ? String(a.maxUsersOk) : `>= ${a.maxUsersOk} (no saturó)`);
console.log(`\n========== ESCALABILIDAD HORIZONTAL (p95 <= ${P95_LIMIT_MS} ms) ==========`);
console.log("                                      1 réplica      2 réplicas");
console.log(`Máx. usuarios sostenidos              ${cell(one).padEnd(14)} ${cell(two)}`);
console.log(`Usuarios al superar el límite         ${String(one.usersAtBreak ?? "-").padEnd(14)} ${two.usersAtBreak ?? "-"}`);
console.log(`Pico de usuarios alcanzado            ${String(one.peakUsers).padEnd(14)} ${two.peakUsers}`);
if (one.maxUsersOk > 0) console.log(`\nGanancia: x${(two.maxUsersOk / one.maxUsersOk).toFixed(2)} usuarios sostenidos con 2 réplicas`);
if (!one.reachedLimit || !two.reachedLimit) console.log("AVISO: una de las pruebas no llegó a saturar; la comparación es un mínimo. Sube la rampa y repite.");
if (!one.reachedLimit && !two.reachedLimit) {
  console.log("\nRESULTADO: INCONCLUSO. Ninguna de las dos pruebas llegó a saturar; sube la rampa de scenarios/stress.yml y repite.");
} else if (two.maxUsersOk > one.maxUsersOk) {
  console.log("\nRESULTADO: 2 réplicas sostienen más usuarios que 1 con el mismo p95.");
} else {
  console.log("\nRESULTADO: 2 réplicas NO sostienen más usuarios que 1; revisar cuellos de botella (Redis, balanceador, generador).");
}
console.log("");
