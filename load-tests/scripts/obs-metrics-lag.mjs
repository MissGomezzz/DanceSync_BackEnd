// OBS-1 measure 1: metrics visible with at most 15 s of delay.
//
// Usage (from load-tests/, after `npm install`; the stack starts if it is not running):
//   node scripts/obs-metrics-lag.mjs [--samples 20] [--poll-ms 200]
//
// Each sample creates a room through the api-gateway (POST /api/rooms) at a known time and polls the
// Prometheus HTTP API until battle-service's request counter for that route has gone up, which is the
// same series the dashboards read. Lag = time from sending the request to the first Prometheus answer
// that includes it (scrape interval 5 s). Grafana refreshes every 5 s on top of it: the worst case on
// screen is reported as max + 5 s. Samples are spread with a random pause so they fall at every point
// of the scrape cycle. Writes reports/obs-metrics-lag-<timestamp>.json.
import { ensureStack, flag, log, machine, mintEntraToken, option, percentile, post, promValue, sleep, writeReport } from "../lib/obs-stack.mjs";

const SAMPLES = Number(option("samples", 20));
const POLL_MS = Number(option("poll-ms", 200));
const TARGET_MS = 15_000;
const GRAFANA_REFRESH_MS = 5_000;
const GIVE_UP_MS = 60_000;
const COUNTER = 'sum(dancesync_http_request_duration_seconds_count{method="POST", route="/api/rooms"})';

async function sample(n) {
  const before = await promValue(COUNTER);
  const host = `lag${Date.now().toString(36)}${n}`;
  const token = mintEntraToken({ oid: host, name: `Lag ${n}` });
  const sentAt = Date.now();
  const created = await post("/api/rooms", { displayName: `Lag ${n}` }, { token, ip: `198.18.200.${n + 1}` });
  const answeredAt = Date.now();
  for (;;) {
    const value = await promValue(COUNTER);
    if (value >= before + 1) {
      const seenAt = Date.now();
      return { sample: n + 1, room: created.body.code, sentAt: new Date(sentAt).toISOString(), requestMs: answeredAt - sentAt, lagMs: seenAt - sentAt, counterBefore: before, counterAfter: value };
    }
    if (Date.now() - sentAt > GIVE_UP_MS) return { sample: n + 1, room: created.body.code, sentAt: new Date(sentAt).toISOString(), lagMs: null, error: "not visible after 60 s" };
    await sleep(POLL_MS);
  }
}

async function main() {
  if (!flag("no-start")) await ensureStack();
  const startedAt = new Date().toISOString();
  const samples = [];
  for (let n = 0; n < SAMPLES; n += 1) {
    const s = await sample(n);
    samples.push(s);
    log(`Sample ${s.sample}/${SAMPLES}: room ${s.room}, visible in Prometheus after ${s.lagMs} ms`);
    // Random pause: the next sample lands at another point of the 5 s scrape cycle.
    await sleep(1_000 + Math.random() * 4_000);
  }
  const lags = samples.map((s) => s.lagMs).filter((v) => v !== null);
  const max = lags.length ? Math.max(...lags) : null;
  const report = {
    scenario: "OBS-1 metrics delay: a room created through the gateway until Prometheus reflects it",
    startedAt,
    finishedAt: new Date().toISOString(),
    setup: {
      samples: SAMPLES,
      counter: COUNTER,
      path: "client -> api-gateway -> nginx -> battle-service (/metrics) -> Prometheus (scrape 5 s, timeout 3 s)",
      pollMs: POLL_MS,
      grafanaRefreshMs: GRAFANA_REFRESH_MS,
      machine: machine(),
    },
    result: {
      visible: lags.length,
      notVisible: samples.length - lags.length,
      p50Ms: percentile(lags, 50),
      p95Ms: percentile(lags, 95),
      maxMs: max,
      minMs: lags.length ? Math.min(...lags) : null,
      worstCaseOnDashboardMs: max === null ? null : max + GRAFANA_REFRESH_MS,
      targetMs: TARGET_MS,
      meetsTarget: max !== null && lags.length === samples.length && max <= TARGET_MS,
      meetsTargetIncludingGrafanaRefresh: max !== null && lags.length === samples.length && max + GRAFANA_REFRESH_MS <= TARGET_MS,
    },
    samples,
  };
  writeReport("obs-metrics-lag", report);
  log(`Lag p50 ${report.result.p50Ms} ms, p95 ${report.result.p95Ms} ms, max ${report.result.maxMs} ms (target <= ${TARGET_MS} ms): ${report.result.meetsTarget ? "PASS" : "FAIL"}`);
  return report.result.meetsTarget;
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
