// Uso: node scripts/run.mjs <smoke|nominal|stress|abuse|abuse-smoke> [--target URL] [--label etiqueta]
// Ejecuta Artillery, mide los recursos de la máquina y de los contenedores, guarda el JSON en results/
// e imprime el resumen con el veredicto. Solo permite UNA prueba a la vez: dos generadores en la misma
// máquina se disputan CPU y red, y los resultados dejan de valer.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { startMonitor } from "./monitor.mjs";

const args = process.argv.slice(2);
const scenario = args[0];
if (!["smoke", "nominal", "stress", "abuse", "abuse-smoke"].includes(scenario)) {
  console.error("Uso: node scripts/run.mjs <smoke|nominal|stress|abuse|abuse-smoke> [--target URL] [--label etiqueta]");
  process.exit(2);
}
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const target = opt("target", "http://localhost:8080");
const label = opt("label", "run");
mkdirSync("results", { recursive: true });

// --- Una sola prueba a la vez ---------------------------------------------------------------
const LOCK = "results/.running";
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
if (existsSync(LOCK)) {
  try {
    const other = JSON.parse(readFileSync(LOCK, "utf8"));
    if (alive(other.pid)) {
      console.error(`\nYa hay una prueba en curso: "${other.scenario}" (${other.label}), iniciada ${other.startedAt}.`);
      console.error("Espera a que termine (o ciérrala con Ctrl+C). Dos pruebas a la vez comparten máquina y dan resultados inválidos.\n");
      process.exit(3);
    }
  } catch {
    /* candado ilegible: se reemplaza */
  }
}
const startedAt = new Date();
writeFileSync(LOCK, JSON.stringify({ pid: process.pid, scenario, label, startedAt: startedAt.toISOString() }));
const release = () => {
  try {
    unlinkSync(LOCK);
  } catch {
    /* ya liberado */
  }
};
process.on("exit", release);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// --- Qué se está probando (para no mezclar corridas al comparar) -----------------------------
const docker = (...a) => {
  try {
    return execFileSync("docker", a, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch {
    return null;
  }
};
const replicasRaw = docker("exec", "dancesync-lb", "grep", "-c", "^ *server ", "/etc/nginx/upstream.conf");
const nanoCpus = docker("inspect", "dancesync-battle-1", "--format", "{{.HostConfig.NanoCpus}}");
const replicas = replicasRaw && /^\d+$/.test(replicasRaw) ? Number(replicasRaw) : null;
const cpusPerReplica = nanoCpus && Number(nanoCpus) > 0 ? Number(nanoCpus) / 1e9 : null;

const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = `results/${scenario}-${label}-${stamp}.json`;
console.log(`Escenario: ${scenario} | destino: ${target} | salida: ${out}`);
console.log(`Réplicas con tráfico en el balanceador: ${replicas ?? "no detectado"} | CPU por réplica: ${cpusPerReplica ?? "no detectado"}\n`);

const monitor = startMonitor(out.replace(/\.json$/, ".recursos.csv"));
const artillery = spawn("npx", ["artillery", "run", "-t", target, "-o", out, `scenarios/${scenario}.yml`], { stdio: "inherit", shell: true });
const runCode = await new Promise((resolve) => artillery.on("close", resolve));
const resources = monitor.stop();
const endedAt = new Date();

writeFileSync(
  out.replace(/\.json$/, ".meta.json"),
  JSON.stringify({ scenario, label, target, replicas, cpusPerReplica, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), resources }, null, 2),
);

console.log("\nRecursos durante la prueba (muestras cada 5 s; el 100 % de docker stats es UN núcleo):");
for (const [name, r] of Object.entries(resources)) {
  const cap = name.startsWith("dancesync-battle") && cpusPerReplica ? ` (tope ${(cpusPerReplica * 100).toFixed(0)} %${r.maxCpu >= cpusPerReplica * 90 ? ", AL TOPE" : ""})` : "";
  console.log(`  ${name.padEnd(28)} CPU máx ${String(r.maxCpu).padStart(6)} %  prom ${String(r.avgCpu).padStart(6)} %${cap}`);
}

const summary = spawnSync("node", ["scripts/summary.mjs", out, scenario], { stdio: "inherit", shell: true });
process.exit(summary.status ?? runCode ?? 1);
