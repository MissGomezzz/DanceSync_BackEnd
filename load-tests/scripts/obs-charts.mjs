#!/usr/bin/env node
/**
 * OBS-1 evidence charts. Reads the latest obs-* reports in load-tests/reports and writes three SVG
 * files to load-tests/reports/charts, in the same visual language as failover-charts.mjs:
 *
 *   obs1-scorecard.svg     the three OBS-1 measures: target vs worst result
 *   obs1-alert-time.svg    time until the alert is firing, per run and alert, vs the 60 s target
 *   obs1-metrics-lag.svg   delay until Prometheus reflects a room, per sample, vs the 15 s target
 *
 * Usage: node scripts/obs-charts.mjs   (from load-tests/)
 * The SVGs follow the viewer's light or dark color scheme.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const reportsDir = join(here, "..", "reports");
const chartsDir = join(reportsDir, "charts");

const LAG_TARGET_S = 15;
const ALERT_TARGET_S = 60;
const GRAFANA_REFRESH_S = 5;

// ---------------------------------------------------------------------------
// Data: the latest report of each kind

function latest(prefix) {
  const files = readdirSync(reportsDir)
    .filter((file) => file.startsWith(`${prefix}-`) && file.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error(`No ${prefix}-*.json report in ${reportsDir}`);
  const file = files[files.length - 1];
  return { ...JSON.parse(readFileSync(join(reportsDir, file), "utf8")), file };
}

const seconds = (ms) => ms / 1000;
const fmtS = (value) => `${value.toFixed(1)} s`;

// ---------------------------------------------------------------------------
// SVG helpers (same tokens and marks as failover-charts.mjs)

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const STYLE = `
  <style>
    svg { --surface: #fcfcfb; --text-1: #0b0b0b; --text-2: #52514e; --text-3: #6f6e69;
          --grid: #e4e3df; --axis: #a9a8a2; --series-1: #2a78d6; --series-2: #eb6834;
          --good: #006300; --good-fill: #e3f1e3; --bad: #b3261e; --bad-fill: #fbe9e7; --target: #0b0b0b; }
    @media (prefers-color-scheme: dark) {
      svg { --surface: #1a1a19; --text-1: #f0efec; --text-2: #c3c2b7; --text-3: #9d9c94;
            --grid: #2e2e2c; --axis: #5c5b56; --series-1: #3987e5; --series-2: #d95926;
            --good: #5fc85f; --good-fill: #1f2e1f; --bad: #f28b82; --bad-fill: #3a1f1d; --target: #f0efec; }
    }
    text { font-family: ${FONT}; fill: var(--text-2); }
    .title { font-size: 16px; font-weight: 600; fill: var(--text-1); }
    .subtitle { font-size: 12px; fill: var(--text-2); }
    .tick { font-size: 11px; fill: var(--text-3); }
    .label { font-size: 12px; fill: var(--text-1); }
    .detail { font-size: 11px; fill: var(--text-3); }
    .value { font-size: 11px; font-weight: 600; fill: var(--text-1); }
    .target-label { font-size: 11px; font-weight: 600; fill: var(--text-1); }
    .note { font-size: 11px; fill: var(--text-3); }
  </style>`;

const esc = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function svgDoc(width, height, title, description, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d">
  <title id="t">${esc(title)}</title>
  <desc id="d">${esc(description)}</desc>${STYLE}
  <rect width="${width}" height="${height}" fill="var(--surface)"/>
${body}
</svg>
`;
}

/** Vertical bar anchored to the baseline, 4 px rounded data end. */
function vBar(x, y, width, height, fill, tooltip) {
  if (height <= 0) return "";
  const r = Math.min(4, width / 2, height);
  const path = `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
  return `<path d="${path}" fill="${fill}"><title>${esc(tooltip)}</title></path>`;
}

function legend(x, y, items) {
  let cursor = x;
  return items
    .map(({ label, fill }) => {
      const item = `<rect x="${cursor}" y="${y - 9}" width="10" height="10" rx="2" fill="${fill}"/>
  <text class="label" x="${cursor + 16}" y="${y}">${esc(label)}</text>`;
      cursor += 16 + label.length * 6.6 + 20;
      return item;
    })
    .join("\n  ");
}

function horizontalGrid(left, plotW, y, ticks) {
  return ticks
    .map((s) => `  <line x1="${left}" x2="${left + plotW}" y1="${y(s)}" y2="${y(s)}" stroke="var(--grid)" stroke-width="1"/>
  <text class="tick" x="${left - 8}" y="${y(s) + 4}" text-anchor="end">${s} s</text>`)
    .join("\n");
}

function targetLine(left, plotW, yValue, label) {
  return `  <line x1="${left}" x2="${left + plotW}" y1="${yValue}" y2="${yValue}" stroke="var(--target)" stroke-width="1.5" stroke-dasharray="6 4"/>
  <text class="target-label" x="${left + plotW}" y="${yValue - 8}" text-anchor="end">${label}</text>`;
}

// ---------------------------------------------------------------------------
// Chart 1: scorecard

function scorecard(lag, alert, trace) {
  const worstLag = seconds(lag.result.maxMs);
  const worstAlert = Math.max(seconds(alert.replicaDown.maxMs), seconds(alert.latency.maxMs));
  const traced = Object.entries({ "api-gateway": trace.services["api-gateway"], "battle-service": trace.services["battle-service"], "users-service": trace.services["users-service"] }).filter(([, n]) => n > 0).length;
  const tiles = [
    { label: "Metrics delay", value: fmtS(worstLag), detail: `worst of ${lag.samples.length} samples`, target: `Target <= ${LAG_TARGET_S} s`, met: lag.result.meetsTarget },
    {
      label: "Alert fired",
      value: fmtS(worstAlert),
      detail: `worst of ${alert.replicaDown.runs.length + alert.latency.runs.length} runs`,
      target: `Target < ${ALERT_TARGET_S} s`,
      met: alert.replicaDown.meetsTarget && alert.latency.meetsTarget,
    },
    { label: "Traced services", value: `${traced} of 3`, detail: "one correlation id", target: "Target 3 of 3", met: trace.pass },
  ];

  const width = 760;
  const left = 24;
  const gap = 12;
  const tileW = (width - left * 2 - gap * 2) / 3;
  const top = 76;
  const tileH = 132;
  const height = top + tileH + 44;

  const body = tiles
    .map((tile, i) => {
      const x = left + i * (tileW + gap);
      const status = tile.met ? "Met" : "Not met";
      return `  <g>
    <rect x="${x}" y="${top}" width="${tileW}" height="${tileH}" rx="8" fill="none" stroke="var(--grid)" stroke-width="1"/>
    <text class="subtitle" x="${x + 14}" y="${top + 24}">${esc(tile.label)}</text>
    <text x="${x + 14}" y="${top + 62}" style="font-size: 30px; font-weight: 600; fill: var(--text-1)">${esc(tile.value)}</text>
    <text class="detail" x="${x + 14}" y="${top + 80}">${esc(tile.detail)}</text>
    <text class="label" x="${x + 14}" y="${top + 112}">${esc(tile.target)}</text>
    <rect x="${x + tileW - 76}" y="${top + 98}" width="64" height="20" rx="10" fill="var(${tile.met ? "--good-fill" : "--bad-fill"})"/>
    <text x="${x + tileW - 44}" y="${top + 112}" text-anchor="middle" style="font-size: 11px; font-weight: 600; fill: var(${tile.met ? "--good" : "--bad"})">${tile.met ? "&#10003; " : "&#10007; "}${status}</text>
  </g>`;
    })
    .join("\n");

  const allMet = tiles.every((t) => t.met);
  const header = `  <text class="title" x="${left}" y="30">OBS-1 observability: ${allMet ? "all three measures met" : "measures"}</text>
  <text class="subtitle" x="${left}" y="52">Prometheus scrape and rule evaluation every 5 s, Grafana refresh 5 s, alert rules with for: 15s.</text>`;
  const footer = `  <text class="note" x="${left}" y="${height - 16}">Local stack: docker-compose.observability.yml (gateway, nginx, 2 battle replicas, users-service, Redis, PostgreSQL). Source: load-tests/reports/obs-*.json</text>`;
  return svgDoc(width, height, "OBS-1 observability scorecard", tiles.map((t) => `${t.label}: ${t.value} (${t.target}, ${t.met ? "met" : "not met"})`).join("; "), `${header}\n${body}\n${footer}`);
}

// ---------------------------------------------------------------------------
// Chart 2: alert time per run

function alertChart(alert) {
  const down = alert.replicaDown.runs;
  const latency = alert.latency.runs;
  const runs = Math.max(down.length, latency.length);
  const width = 760;
  const height = 400;
  const left = 56;
  const right = 24;
  const top = 96;
  const bottom = 56;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const maxY = 65;
  const y = (s) => top + plotH - (Math.min(s, maxY) / maxY) * plotH;

  const groupW = plotW / runs;
  const barW = Math.min(30, groupW / 3);
  const bars = Array.from({ length: runs }, (_, i) => {
    const cx = left + groupW * i + groupW / 2;
    const parts = [];
    const d = down[i];
    const l = latency[i];
    if (d && d.timeToFireMs !== null) {
      const s = seconds(d.timeToFireMs);
      const x = cx - barW - 1;
      parts.push(`  ${vBar(x, y(s), barW, y(0) - y(s), "var(--series-1)", `Run ${i + 1}, BattleReplicaDown (${d.victim} killed): ${fmtS(s)}`)}
  <text class="value" x="${x + barW / 2}" y="${y(s) - 6}" text-anchor="middle">${s.toFixed(0)}</text>`);
    }
    if (l && l.timeToFireMs !== null) {
      const s = seconds(l.timeToFireMs);
      const x = cx + 1;
      parts.push(`  ${vBar(x, y(s), barW, y(0) - y(s), "var(--series-2)", `Run ${i + 1}, HighRealtimeLatency (${l.degraded} degraded): ${fmtS(s)}`)}
  <text class="value" x="${x + barW / 2}" y="${y(s) - 6}" text-anchor="middle">${s.toFixed(0)}</text>`);
    }
    parts.push(`  <text class="label" x="${cx}" y="${y(0) + 20}" text-anchor="middle">Run ${i + 1}</text>`);
    if (d) parts.push(`  <text class="detail" x="${cx}" y="${y(0) + 36}" text-anchor="middle">${esc(`${d.victim} killed`)}</text>`);
    return parts.join("\n");
  }).join("\n");

  const header = `  <text class="title" x="24" y="30">Time until the alert is firing</text>
  <text class="subtitle" x="24" y="52">Seconds from the degradation (t0) until Prometheus reports the alert as firing, under load, per run</text>
  ${legend(24, 78, [
    { label: "BattleReplicaDown (replica killed)", fill: "var(--series-1)" },
    { label: `HighRealtimeLatency (${alert.latency.runs[0]?.mode === "cpu" ? "CPU limited" : "Redis slowed"})`, fill: "var(--series-2)" },
  ])}`;
  const axis = `  <line x1="${left}" x2="${left + plotW}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1"/>`;
  const description = [
    ...down.map((r) => `Run ${r.run} BattleReplicaDown: ${r.timeToFireMs === null ? "did not fire" : fmtS(seconds(r.timeToFireMs))}`),
    ...latency.map((r) => `Run ${r.run} HighRealtimeLatency: ${r.timeToFireMs === null ? "did not fire" : fmtS(seconds(r.timeToFireMs))}`),
  ].join("; ");
  return svgDoc(
    width,
    height,
    "OBS-1 time to alert per run",
    description,
    `${header}\n${horizontalGrid(left, plotW, y, [0, 10, 20, 30, 40, 50, 60])}\n${targetLine(left, plotW, y(ALERT_TARGET_S), `Target: alert in &lt; ${ALERT_TARGET_S} s`)}\n${bars}\n${axis}`,
  );
}

// ---------------------------------------------------------------------------
// Chart 3: metrics lag per sample

function lagChart(lag) {
  const samples = lag.samples;
  const width = 760;
  const height = 380;
  const left = 56;
  const right = 24;
  const top = 96;
  const bottom = 44;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const maxY = 16;
  const y = (s) => top + plotH - (Math.min(s, maxY) / maxY) * plotH;
  const slotW = plotW / samples.length;
  const barW = Math.min(20, slotW * 0.6);

  const bars = samples
    .map((s, i) => {
      const cx = left + slotW * i + slotW / 2;
      const value = s.lagMs === null ? maxY : seconds(s.lagMs);
      return `  ${vBar(cx - barW / 2, y(value), barW, y(0) - y(value), "var(--series-1)", `Sample ${s.sample}: ${s.lagMs === null ? "not visible" : fmtS(value)}`)}
  <text class="tick" x="${cx}" y="${y(0) + 16}" text-anchor="middle">${s.sample}</text>`;
    })
    .join("\n");

  const p95 = seconds(lag.result.p95Ms);
  const p95Line = `  <line x1="${left}" x2="${left + plotW}" y1="${y(p95)}" y2="${y(p95)}" stroke="var(--series-2)" stroke-width="1.5"/>
  <text class="value" x="${left + 6}" y="${y(p95) - 6}">p95 ${fmtS(p95)}</text>`;
  const header = `  <text class="title" x="24" y="30">Delay until a new event is visible in Prometheus</text>
  <text class="subtitle" x="24" y="52">Seconds from creating a room through the gateway until Prometheus reflects it, ${samples.length} samples (Grafana adds up to ${GRAFANA_REFRESH_S} s)</text>
  ${legend(24, 78, [
    { label: "Delay per sample", fill: "var(--series-1)" },
    { label: "p95", fill: "var(--series-2)" },
  ])}`;
  const axis = `  <line x1="${left}" x2="${left + plotW}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1"/>
  <text class="detail" x="${left + plotW / 2}" y="${height - 8}" text-anchor="middle">Sample</text>`;
  const description = `p50 ${fmtS(seconds(lag.result.p50Ms))}, p95 ${fmtS(p95)}, max ${fmtS(seconds(lag.result.maxMs))} over ${samples.length} samples`;
  return svgDoc(
    width,
    height,
    "OBS-1 metrics delay per sample",
    description,
    `${header}\n${horizontalGrid(left, plotW, y, [0, 3, 6, 9, 12, 15])}\n${targetLine(left, plotW, y(LAG_TARGET_S), `Target: visible in &lt;= ${LAG_TARGET_S} s`)}\n${bars}\n${p95Line}\n${axis}`,
  );
}

// ---------------------------------------------------------------------------

const lag = latest("obs-metrics-lag");
const alert = latest("obs-alert-time");
const trace = latest("obs-trace");

mkdirSync(chartsDir, { recursive: true });
const outputs = {
  "obs1-scorecard.svg": scorecard(lag, alert, trace),
  "obs1-alert-time.svg": alertChart(alert),
  "obs1-metrics-lag.svg": lagChart(lag),
};
for (const [name, svg] of Object.entries(outputs)) {
  writeFileSync(join(chartsDir, name), svg);
  console.log(`wrote reports/charts/${name}`);
}
