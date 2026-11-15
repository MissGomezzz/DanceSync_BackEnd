// OBS-1 measure 2: degradation detected and alerted in under 1 minute.
//
// Usage (from load-tests/, after `npm install`; the stack starts if it is not running):
//   node scripts/obs-alert-time.mjs [--down-runs 5] [--latency-runs 5] [--latency-mode redis|cpu]
//                                   [--rooms 8] [--room-size 7] [--keep-load-s 0]
//
// A background load of rooms plays battle after battle through the api-gateway the whole time.
//
// Case 1, replica down (5 runs): `docker kill` one battle-service replica at t0 (alternating battle-1 and
// battle-2) and poll Prometheus /api/v1/alerts every 250 ms until BattleReplicaDown is firing for it.
// Then the replica is started again, and the next run waits until it is healthy, scraped and the
// alert has resolved, and until the load is back (open connections >= 90 % of the baseline).
//
// nginx is reloaded after each restart (`nginx -s reload`, existing connections are kept). Without it,
// nginx OSS's passive health check (max_fails=1) keeps a replica that failed out of rotation until a
// probe request to it *finishes*, and with WebSocket-only clients the probe is a connection that lasts
// minutes: the restarted replica receives one new connection every fail_timeout (10 s), and once the
// other replica is killed too, nginx answers "no live upstreams". The reload resets that state, as an
// operator (or the platform's readiness probe in Azure) would. See docs/quality/OBS-1-observabilidad.md.
//
// Case 2, latency (5 runs): degrade at t0 and poll until HighRealtimeLatency is firing.
//   redis (default): Redis is put to sleep in a loop (DEBUG SLEEP 0.4 s, 50 ms awake), so every
//                    Socket.IO event that touches the room state waits for it.
//   cpu:             one replica is limited to 0.02 CPUs (docker update --cpus).
// The degradation is removed as soon as the alert fires, and the next run waits until it resolves.
//
// Time to fire = first poll that sees the alert firing - t0 (the poll adds at most 250 ms). The report
// also keeps Prometheus' own activeAt (when the rule first matched, start of the `for: 15s`).
// Writes reports/obs-alert-time-<timestamp>.json.
import { alerts, compose, containerOf, docker, ensureStack, flag, healthOf, log, machine, option, percentile, promValue, sleep, startLoad, writeReport } from "../lib/obs-stack.mjs";

const DOWN_RUNS = Number(option("down-runs", 5));
const LATENCY_RUNS = Number(option("latency-runs", 5));
const LATENCY_MODE = option("latency-mode", "redis");
const ROOMS = Number(option("rooms", 8));
const ROOM_SIZE = Number(option("room-size", 7));
const TARGET_MS = 60_000;
const GIVE_UP_MS = 180_000;
const POLL_MS = 250;

async function waitForAlert(name, matches, t0) {
  let pendingSeenAt = null;
  for (;;) {
    const list = (await alerts().catch(() => [])).filter((a) => a.labels.alertname === name && matches(a));
    const pending = list.find((a) => a.state === "pending");
    if (pending && pendingSeenAt === null) pendingSeenAt = Date.now();
    const firing = list.find((a) => a.state === "firing");
    if (firing) {
      const firingSeenAt = Date.now();
      return {
        fired: true,
        timeToFireMs: firingSeenAt - t0,
        pendingSeenAfterMs: pendingSeenAt === null ? null : pendingSeenAt - t0,
        prometheusActiveAfterMs: Date.parse(firing.activeAt) - t0,
        labels: firing.labels,
        value: Number(firing.value),
      };
    }
    if (Date.now() - t0 > GIVE_UP_MS) return { fired: false, timeToFireMs: null };
    await sleep(POLL_MS);
  }
}

async function waitUntilNoAlert(name, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = (await alerts().catch(() => [])).filter((a) => a.labels.alertname === name);
    if (active.length === 0) return true;
    await sleep(1_000);
  }
  return false;
}

async function waitUntilReplicaBack(service, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await healthOf(service).catch(() => "");
    const up = await promValue(`up{job="battle-service", instance="${service}"}`).catch(() => 0);
    if (health === "running healthy" && up === 1) return true;
    await sleep(1_000);
  }
  return false;
}

/** Open Socket.IO connections on every replica, as Prometheus sees them. */
const connections = () => promValue("sum(dancesync_socket_connections)").catch(() => 0);
let baselineConnections = 0;

async function waitForLoad(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let open = await connections();
  while (open < 0.9 * baselineConnections && Date.now() < deadline) {
    await sleep(1_000);
    open = await connections();
  }
  return open;
}

async function replicaDownRun(run) {
  const victim = run % 2 === 1 ? "battle-1" : "battle-2";
  await waitUntilNoAlert("BattleReplicaDown");
  const openAtKill = await waitForLoad();
  const id = await containerOf(victim);
  log(`Replica down, run ${run}/${DOWN_RUNS}: docker kill ${victim}...`);
  const t0 = Date.now();
  await docker(["kill", "-s", "SIGKILL", id]);
  const result = await waitForAlert("BattleReplicaDown", (a) => a.labels.instance === victim, t0);
  log(`  BattleReplicaDown ${result.fired ? `firing after ${result.timeToFireMs} ms` : "did NOT fire"}. Starting ${victim} again...`);
  await compose(["start", victim]);
  const back = await waitUntilReplicaBack(victim);
  await compose(["exec", "-T", "nginx", "nginx", "-s", "reload"]);
  const resolved = await waitUntilNoAlert("BattleReplicaDown");
  return { run, victim, killedAt: new Date(t0).toISOString(), openConnectionsAtKill: openAtKill, ...result, replicaBackHealthy: back, alertResolvedAfterRestart: resolved };
}

async function degrade(run) {
  if (LATENCY_MODE === "cpu") {
    const target = run % 2 === 1 ? "battle-1" : "battle-2";
    const id = await containerOf(target);
    await docker(["update", "--cpus", "0.02", id]);
    return { target, restore: () => docker(["update", "--cpus", process.env.BATTLE_CPUS ?? "1.0", id]) };
  }
  // Redis sleeps 0.4 s, wakes up for 50 ms, and again, until /tmp/obs1-stop exists.
  const loop = "rm -f /tmp/obs1-stop; while [ ! -f /tmp/obs1-stop ]; do redis-cli DEBUG SLEEP 0.4 >/dev/null; sleep 0.05; done";
  const running = compose(["exec", "-T", "redis", "sh", "-c", loop], { timeout: GIVE_UP_MS + 30_000, allowFail: true });
  return {
    target: "redis",
    restore: async () => {
      await compose(["exec", "-T", "redis", "touch", "/tmp/obs1-stop"]);
      await running;
    },
  };
}

async function latencyRun(run) {
  await waitUntilNoAlert("HighRealtimeLatency");
  const openAtStart = await waitForLoad();
  log(`Latency, run ${run}/${LATENCY_RUNS} (${LATENCY_MODE})...`);
  const t0 = Date.now();
  const degradation = await degrade(run);
  const result = await waitForAlert("HighRealtimeLatency", () => true, t0);
  log(`  HighRealtimeLatency ${result.fired ? `firing after ${result.timeToFireMs} ms (${result.labels.instance}, p95 ${Math.round(result.value * 1000)} ms)` : "did NOT fire"}. Removing the degradation...`);
  await degradation.restore();
  const resolved = await waitUntilNoAlert("HighRealtimeLatency");
  return { run, mode: LATENCY_MODE, degraded: degradation.target, degradedAt: new Date(t0).toISOString(), openConnectionsAtStart: openAtStart, ...result, alertResolvedAfterRestore: resolved };
}

function summary(runs) {
  const times = runs.map((r) => r.timeToFireMs).filter((v) => v !== null);
  return {
    runs: runs.length,
    fired: times.length,
    minMs: times.length ? Math.min(...times) : null,
    p50Ms: percentile(times, 50),
    maxMs: times.length ? Math.max(...times) : null,
    targetMs: TARGET_MS,
    meetsTarget: times.length === runs.length && runs.length > 0 && Math.max(...times) < TARGET_MS,
  };
}

async function main() {
  if (!flag("no-start")) await ensureStack();
  const startedAt = new Date().toISOString();
  log(`Background load: ${ROOMS} rooms of ${ROOM_SIZE} users through the gateway...`);
  const load = startLoad({ rooms: ROOMS, roomSize: ROOM_SIZE });
  const battling = await load.untilBattling();
  log(`${battling}/${ROOMS} rooms battling. Warming up 20 s...`);
  await sleep(20_000);
  baselineConnections = await connections();
  log(`Baseline: ${baselineConnections} open connections.`);

  const down = [];
  for (let run = 1; run <= DOWN_RUNS; run += 1) down.push(await replicaDownRun(run));
  const latency = [];
  for (let run = 1; run <= LATENCY_RUNS; run += 1) latency.push(await latencyRun(run));

  const keep = Number(option("keep-load-s", 0));
  if (keep > 0) {
    log(`Keeping the load for ${keep} s more (dashboards)...`);
    await sleep(keep * 1000);
  }
  await load.stop();

  const report = {
    scenario: "OBS-1 alert time: degradation under load until the Prometheus alert is firing",
    startedAt,
    finishedAt: new Date().toISOString(),
    setup: {
      load: { rooms: ROOMS, roomSize: ROOM_SIZE, roomsBattlingAtStart: battling, baselineConnections, battlesFinished: load.battlesFinished, setupErrors: load.setupErrors, cycleErrors: load.cycleErrors },
      prometheus: "scrape and evaluation every 5 s, scrape timeout 3 s; rules with for: 15s (observability/prometheus/alert-rules.yml)",
      latencyMode: LATENCY_MODE === "cpu" ? "one replica limited to 0.02 CPUs (docker update --cpus)" : "Redis DEBUG SLEEP 0.4 s in a loop (50 ms awake between sleeps)",
      pollMs: POLL_MS,
      machine: machine(),
    },
    replicaDown: { alert: "BattleReplicaDown", ...summary(down), runs: down },
    latency: { alert: "HighRealtimeLatency", ...summary(latency), runs: latency },
  };
  report.replicaDown.runCount = down.length;
  report.latency.runCount = latency.length;
  writeReport("obs-alert-time", report);
  log(`BattleReplicaDown: ${down.map((r) => r.timeToFireMs).join(", ")} ms; HighRealtimeLatency: ${latency.map((r) => r.timeToFireMs).join(", ")} ms (target < ${TARGET_MS} ms)`);
  return report.replicaDown.meetsTarget && report.latency.meetsTarget;
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
