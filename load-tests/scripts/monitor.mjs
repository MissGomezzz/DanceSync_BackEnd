// Recursos durante una prueba: CPU de la máquina y de cada contenedor (docker stats), una muestra cada 5 s.
// Si Docker no está disponible solo se mide la máquina. Un fallo aquí nunca debe romper la prueba.
import { execFile } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import os from "node:os";

function hostTimes() {
  let idle = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** "7.6MiB / 31.2GiB" -> 7.6. Solo cuenta lo usado: la unidad del límite no se mezcla con la del valor. */
function toMiB(usage = "") {
  const used = usage.split("/")[0].trim();
  const value = parseFloat(used);
  if (Number.isNaN(value)) return 0;
  if (/GiB|GB/.test(used)) return value * 1024;
  if (/KiB|kB/.test(used)) return value / 1024;
  if (/^[\d.]+B$/.test(used)) return value / 1048576;
  return value; // MiB o MB
}

function dockerSample() {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["stats", "--no-stream", "--format", "{{.Name}},{{.CPUPerc}},{{.MemUsage}}"],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve([]);
        const rows = [];
        for (const line of stdout.split(/\r?\n/)) {
          const [name, cpu, mem] = line.split(",");
          if (!name?.startsWith("dancesync")) continue;
          rows.push({ name, cpu: parseFloat(cpu), memMiB: toMiB(mem) });
        }
        resolve(rows);
      },
    );
  });
}

export function startMonitor(csvFile, intervalMs = 5000) {
  writeFileSync(csvFile, "time,name,cpu_percent,mem_mib\n");
  const stats = new Map(); // name -> { max, sum, n, maxMem }
  const warmUntil = Date.now() + 10_000; // el arranque de Artillery y de los contenedores no cuenta en los máximos
  const add = (name, cpu, mem) => {
    if (Date.now() < warmUntil) return;
    const s = stats.get(name) ?? { max: 0, sum: 0, n: 0, maxMem: 0 };
    s.max = Math.max(s.max, cpu);
    s.sum += cpu;
    s.n += 1;
    s.maxMem = Math.max(s.maxMem, mem ?? 0);
    stats.set(name, s);
  };
  let previous = hostTimes();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = hostTimes();
      const dTotal = now.total - previous.total;
      const hostCpu = dTotal > 0 ? (100 * (dTotal - (now.idle - previous.idle))) / dTotal : 0;
      previous = now;
      const time = new Date().toISOString();
      add("host (todos los núcleos)", hostCpu, (os.totalmem() - os.freemem()) / 1048576);
      appendFileSync(csvFile, `${time},host,${hostCpu.toFixed(1)},\n`);
      for (const r of await dockerSample()) {
        add(r.name, r.cpu, r.memMiB);
        appendFileSync(csvFile, `${time},${r.name},${r.cpu},${r.memMiB.toFixed(1)}\n`);
      }
    } catch {
      /* la monitorización es opcional */
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return Object.fromEntries([...stats].map(([name, s]) => [name, { maxCpu: +s.max.toFixed(1), avgCpu: +(s.sum / s.n).toFixed(1), maxMemMiB: +s.maxMem.toFixed(0), samples: s.n }]));
    },
  };
}
