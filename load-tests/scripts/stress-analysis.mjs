// Análisis de la prueba de estrés: usuarios concurrentes vs p95 de la latencia de chat, por intervalo de Artillery.
// "Sostenido" = el p95 no superó el límite en dos intervalos seguidos: un pico aislado no cuenta como saturación.
export const P95_LIMIT_MS = 300;
const MIN_SAMPLES = 30; // intervalos con muy pocas muestras no son confiables

export function analyzeStress(report, { roomSize = 7, limitMs = P95_LIMIT_MS } = {}) {
  let created = 0;
  let completed = 0;
  const points = [];
  for (const period of report.intermediate ?? []) {
    created += period.counters?.["vusers.created"] ?? 0;
    completed += period.counters?.["vusers.completed"] ?? 0;
    const s = period.summaries?.["dancesync.chat_e2e_ms"];
    if (!s || s.count < MIN_SAMPLES) continue;
    points.push({ users: (created - completed) * roomSize, p95: s.p95, p99: s.p99, ok: s.p95 <= limitMs });
  }
  let breakIndex = points.findIndex((p, i) => !p.ok && points[i + 1] && !points[i + 1].ok);
  const reached = breakIndex >= 0;
  if (!reached) breakIndex = points.length;
  const sustained = points.slice(0, breakIndex).filter((p) => p.ok);
  return {
    points,
    reachedLimit: reached,
    maxUsersOk: sustained.reduce((m, p) => Math.max(m, p.users), 0),
    p95AtMax: sustained.length ? sustained.reduce((best, p) => (p.users >= best.users ? p : best)).p95 : null,
    usersAtBreak: reached ? points[breakIndex].users : null,
    peakUsers: points.reduce((m, p) => Math.max(m, p.users), 0),
  };
}
