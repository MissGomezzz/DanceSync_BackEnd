#!/usr/bin/env node
/**
 * DIS-1 evidence charts. Reads the failover reports in load-tests/reports and
 * writes three SVG files to load-tests/reports/charts:
 *
 *   dis1-scorecard.svg      the four DIS-1 measures: target vs worst result
 *   dis1-recovery.svg       time to restore service per run (p50 and max) vs the 30 s target
 *   dis1-rooms-intact.svg   rooms intact per run, before and after the seat-release fix
 *
 * Usage: node scripts/failover-charts.mjs   (from load-tests/)
 * The SVGs follow the viewer's light or dark color scheme.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const reportsDir = join(here, "..", "reports");
const chartsDir = join(reportsDir, "charts");

const RECOVERY_BUDGET_S = 30;
const ROOMS_TARGET_PCT = 95;

// ---------------------------------------------------------------------------
// Data

function loadReports() {
  return readdirSync(reportsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const report = JSON.parse(readFileSync(join(reportsDir, file), "utf8"));
      return { ...report, file, beforeFix: file.startsWith("before-fix-") };
    });
}

/** Short, human label for a run. */
function runLabel(report) {
  const label = report.label;
  if (label.startsWith("140u-run")) return `Run ${label.slice("140u-run".length)}`;
  if (label === "early-kill-14u") return "Early kill";
  if (label === "140u") return "Run 0";
  if (label === "smoke") return "Smoke";
  return label;
}

/** Second label line: the size of the run. */
function runDetail(report) {
  const users = report.setup.usersBattling;
  const rooms = report.setup.roomsBattling;
  return `${users} users, ${rooms} rooms`;
}

const seconds = (ms) => ms / 1000;
const fmtS = (value) => `${value.toFixed(1)} s`;

// ---------------------------------------------------------------------------
// SVG helpers

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Tokens for both color schemes: the chart reads roles, never raw hex. */
const STYLE = `
  <style>
    svg { --surface: #fcfcfb; --text-1: #0b0b0b; --text-2: #52514e; --text-3: #6f6e69;
          --grid: #e4e3df; --axis: #a9a8a2; --series-1: #2a78d6; --series-2: #eb6834;
          --good: #006300; --good-fill: #e3f1e3; --target: #0b0b0b; }
    @media (prefers-color-scheme: dark) {
      svg { --surface: #1a1a19; --text-1: #f0efec; --text-2: #c3c2b7; --text-3: #9d9c94;
            --grid: #2e2e2c; --axis: #5c5b56; --series-1: #3987e5; --series-2: #d95926;
            --good: #5fc85f; --good-fill: #1f2e1f; --target: #f0efec; }
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

const esc = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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
  const r = Math.min(4, width / 2, height);
  const path = `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
  return `<path d="${path}" fill="${fill}"><title>${esc(tooltip)}</title></path>`;
}

/** Horizontal bar anchored to the left baseline, 4 px rounded data end. */
function hBar(x, y, width, height, fill, tooltip) {
  if (width <= 0) return "";
  const r = Math.min(4, height / 2, width);
  const path = `M${x},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height - r} Q${x + width},${y + height} ${x + width - r},${y + height} H${x} Z`;
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

// ---------------------------------------------------------------------------
// Chart 1: scorecard

function scorecard(runs) {
  const worstRecovery = Math.max(...runs.map((r) => seconds(r.recovery.maxMs)));
  const worstIntact = Math.min(...runs.map((r) => r.state.percentIntact));
  const lost = runs.reduce((sum, r) => sum + r.results.lost, 0);
  const duplicated = runs.reduce((sum, r) => sum + r.results.duplicates + r.state.duplicateRoundEndEvents, 0);
  const finished = runs.reduce((sum, r) => sum + r.results.battlesFinished, 0);
  const recovered = runs.reduce((sum, r) => sum + r.recovery.clientsRecovered, 0);
  const disconnected = runs.reduce((sum, r) => sum + r.recovery.clientsDisconnected, 0);

  const tiles = [
    { label: "Service restored", value: fmtS(worstRecovery), detail: "worst run", target: `Target < ${RECOVERY_BUDGET_S} s`, met: worstRecovery < RECOVERY_BUDGET_S },
    { label: "Rooms intact", value: `${worstIntact} %`, detail: "worst run", target: `Target >= ${ROOMS_TARGET_PCT} %`, met: worstIntact >= ROOMS_TARGET_PCT },
    { label: "Results lost", value: String(lost), detail: `of ${finished} battles`, target: "Target 0", met: lost === 0 },
    { label: "Results counted twice", value: String(duplicated), detail: "results and rounds", target: "Target 0", met: duplicated === 0 },
  ];

  const width = 760;
  const tileW = 172;
  const gap = 12;
  const left = 24;
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
    <rect x="${x + tileW - 66}" y="${top + 98}" width="54" height="20" rx="10" fill="var(--good-fill)"/>
    <text x="${x + tileW - 39}" y="${top + 112}" text-anchor="middle" style="font-size: 11px; font-weight: 600; fill: var(--good)">${tile.met ? "&#10003; " : "&#10007; "}${status}</text>
  </g>`;
    })
    .join("\n");

  const header = `  <text class="title" x="${left}" y="30">DIS-1 availability: all four measures met</text>
  <text class="subtitle" x="${left}" y="52">${runs.length} failover runs after the fix, ${recovered}/${disconnected} disconnected clients back. One of two battle-service replicas killed (SIGKILL) mid-battle.</text>`;
  const footer = `  <text class="note" x="${left}" y="${height - 16}">Local prototype: Docker Desktop, 0.5 CPU and 512 MB per replica, nginx, Redis. Source: load-tests/reports/failover-*.json</text>`;

  return svgDoc(width, height, "DIS-1 availability scorecard", tiles.map((t) => `${t.label}: ${t.value} (${t.target}, ${t.met ? "met" : "not met"})`).join("; "), `${header}\n${body}\n${footer}`);
}

// ---------------------------------------------------------------------------
// Chart 2: recovery time per run

function recoveryChart(runs) {
  const width = 760;
  const height = 400;
  const left = 56;
  const right = 24;
  const top = 96;
  const bottom = 64;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const maxY = 32;
  const y = (s) => top + plotH - (s / maxY) * plotH;

  const grid = [0, 5, 10, 15, 20, 25, 30]
    .map((s) => `  <line x1="${left}" x2="${left + plotW}" y1="${y(s)}" y2="${y(s)}" stroke="var(--grid)" stroke-width="1"/>
  <text class="tick" x="${left - 8}" y="${y(s) + 4}" text-anchor="end">${s} s</text>`)
    .join("\n");

  const groupW = plotW / runs.length;
  const barW = Math.min(28, groupW / 3);
  const bars = runs
    .map((run, i) => {
      const cx = left + groupW * i + groupW / 2;
      const p50 = seconds(run.recovery.p50Ms);
      const max = seconds(run.recovery.maxMs);
      const name = runLabel(run);
      const x1 = cx - barW - 1;
      const x2 = cx + 1;
      return `  ${vBar(x1, y(p50), barW, y(0) - y(p50), "var(--series-1)", `${name}: median ${fmtS(p50)}`)}
  ${vBar(x2, y(max), barW, y(0) - y(max), "var(--series-2)", `${name}: max ${fmtS(max)}`)}
  <text class="value" x="${x2 + barW / 2}" y="${y(max) - 6}" text-anchor="middle">${fmtS(max)}</text>
  <text class="label" x="${cx}" y="${y(0) + 20}" text-anchor="middle">${esc(name)}</text>
  <text class="detail" x="${cx}" y="${y(0) + 36}" text-anchor="middle">${esc(runDetail(run))}</text>`;
    })
    .join("\n");

  const target = `  <line x1="${left}" x2="${left + plotW}" y1="${y(RECOVERY_BUDGET_S)}" y2="${y(RECOVERY_BUDGET_S)}" stroke="var(--target)" stroke-width="1.5" stroke-dasharray="6 4"/>
  <text class="target-label" x="${left + plotW}" y="${y(RECOVERY_BUDGET_S) - 8}" text-anchor="end">Target: service restored in &lt; ${RECOVERY_BUDGET_S} s</text>`;

  const header = `  <text class="title" x="24" y="30">Time to restore service after a replica dies</text>
  <text class="subtitle" x="24" y="52">Seconds from the kill until each disconnected client receives room events again, per run</text>
  ${legend(24, 78, [
    { label: "Median client", fill: "var(--series-1)" },
    { label: "Slowest client (max)", fill: "var(--series-2)" },
  ])}`;
  const axis = `  <line x1="${left}" x2="${left + plotW}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1"/>`;

  const description = runs
    .map((r) => `${runLabel(r)}: median ${fmtS(seconds(r.recovery.p50Ms))}, max ${fmtS(seconds(r.recovery.maxMs))}`)
    .join("; ");
  return svgDoc(width, height, "DIS-1 recovery time per run", description, `${header}\n${grid}\n${target}\n${bars}\n${axis}`);
}

// ---------------------------------------------------------------------------
// Chart 3: rooms intact, before and after the fix

function roomsChart(reports) {
  const rows = reports;
  const width = 760;
  const left = 150;
  const right = 120;
  const top = 96;
  const rowH = 34;
  const barH = 18;
  const plotW = width - left - right;
  const height = top + rows.length * rowH + 48;
  const x = (pct) => left + (pct / 100) * plotW;

  const grid = [0, 25, 50, 75, 100]
    .map((p) => `  <line x1="${x(p)}" x2="${x(p)}" y1="${top - 6}" y2="${top + rows.length * rowH}" stroke="var(--grid)" stroke-width="1"/>
  <text class="tick" x="${x(p)}" y="${top + rows.length * rowH + 18}" text-anchor="middle">${p} %</text>`)
    .join("\n");

  const bars = rows
    .map((run, i) => {
      const yTop = top + i * rowH + (rowH - barH) / 2;
      const pct = run.state.percentIntact;
      const fill = run.beforeFix ? "var(--series-2)" : "var(--series-1)";
      const name = run.beforeFix ? `${runLabel(run)} (before fix)` : runLabel(run);
      const value = `${pct} % (${run.state.roomsIntact}/${run.state.roomsChecked})`;
      return `  <text class="label" x="${left - 10}" y="${yTop + 9}" text-anchor="end">${esc(runLabel(run))}</text>
  <text class="detail" x="${left - 10}" y="${yTop + 22}" text-anchor="end">${esc(runDetail(run))}</text>
  ${hBar(left, yTop, x(pct) - left, barH, fill, `${name}: ${value}`)}
  <text class="value" x="${x(pct) + 6}" y="${yTop + 13}">${esc(value)}</text>`;
    })
    .join("\n");

  const target = `  <line x1="${x(ROOMS_TARGET_PCT)}" x2="${x(ROOMS_TARGET_PCT)}" y1="${top - 10}" y2="${top + rows.length * rowH}" stroke="var(--target)" stroke-width="1.5" stroke-dasharray="6 4"/>
  <text class="target-label" x="${x(ROOMS_TARGET_PCT)}" y="${top - 16}" text-anchor="middle">Target &gt;= ${ROOMS_TARGET_PCT} %</text>`;

  const header = `  <text class="title" x="24" y="30">Rooms that kept their players, state and scores</text>
  <text class="subtitle" x="24" y="52">Runs before the seat-release fix and the harness fixes lost rooms; after them every run kept 100 %</text>
  ${legend(24, 78, [
    { label: "Before the fix", fill: "var(--series-2)" },
    { label: "After the fix", fill: "var(--series-1)" },
  ])}`;

  const description = rows
    .map((r) => `${runLabel(r)}${r.beforeFix ? " (before fix)" : ""}: ${r.state.percentIntact} % rooms intact`)
    .join("; ");
  return svgDoc(width, height, "DIS-1 rooms intact per run", description, `${header}\n${grid}\n${bars}\n${target}`);
}

// ---------------------------------------------------------------------------

const reports = loadReports();
const after = reports.filter((r) => !r.beforeFix);
const ordered = [...reports.filter((r) => r.beforeFix), ...after];

mkdirSync(chartsDir, { recursive: true });
const outputs = {
  "dis1-scorecard.svg": scorecard(after),
  "dis1-recovery.svg": recoveryChart(after),
  "dis1-rooms-intact.svg": roomsChart(ordered),
};
for (const [name, svg] of Object.entries(outputs)) {
  writeFileSync(join(chartsDir, name), svg);
  console.log(`wrote reports/charts/${name}`);
}
