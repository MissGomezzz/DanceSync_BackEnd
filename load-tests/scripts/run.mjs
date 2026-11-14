// Uso: node scripts/run.mjs <smoke|nominal|stress> [--target URL] [--label etiqueta]
// Ejecuta Artillery, guarda el JSON en results/ y imprime el resumen con el veredicto.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const scenario = args[0];
if (!["smoke", "nominal", "stress"].includes(scenario)) {
  console.error("Uso: node scripts/run.mjs <smoke|nominal|stress> [--target URL] [--label etiqueta]");
  process.exit(2);
}
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const target = opt("target", "http://localhost:8080");
const label = opt("label", "run");
mkdirSync("results", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = `results/${scenario}-${label}-${stamp}.json`;

console.log(`Escenario: ${scenario} | destino: ${target} | salida: ${out}\n`);
const run = spawnSync("npx", ["artillery", "run", "-t", target, "-o", out, `scenarios/${scenario}.yml`], {
  stdio: "inherit",
  shell: true,
});
const summary = spawnSync("node", ["scripts/summary.mjs", out, scenario], { stdio: "inherit", shell: true });
process.exit(summary.status ?? run.status ?? 1);
