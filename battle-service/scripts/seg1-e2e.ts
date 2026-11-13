/**
 * SEG-1 end-to-end check: starts the real battle-service and the real
 * api-gateway (its packaged jar), with a local stand-in for the Microsoft
 * Entra ID key set, and tries the six token cases of the scenario through the
 * gateway, over HTTP and over Socket.IO. It then prints the audit trail both
 * services wrote.
 *
 *   cd api-gateway && ./mvnw -q package -DskipTests
 *   cd ../battle-service && pnpm seg1:e2e
 *
 * With --keep-alive the services stay up (for trying the frontend against
 * them) and a room code is printed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { io as connect } from "socket.io-client";
import { FakeEntra, guestToken, tamperedPayload, TEST_CLIENT_ID, TEST_TENANT_ID } from "../test/support/auth.js";

const GATEWAY_PORT = Number(process.env.SEG1_GATEWAY_PORT ?? 8180);
const BATTLE_PORT = Number(process.env.SEG1_BATTLE_PORT ?? 3100);
const FRONTEND_ORIGIN = process.env.SEG1_FRONTEND_ORIGIN ?? "http://localhost:5173";
const GATEWAY = `http://localhost:${GATEWAY_PORT}`;
const GATEWAY_JAR = "../api-gateway/target/api-gateway-0.0.1-SNAPSHOT.jar";
const GUEST_SECRET = "test-guest-secret-of-at-least-32-bytes!!";
const keepAlive = process.argv.includes("--keep-alive");

const logs: Record<string, string[]> = { "api-gateway": [], "battle-service": [] };
const children: ChildProcess[] = [];

function start(name: string, command: string, args: string[], env: Record<string, string>): void {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const keep = (chunk: Buffer) => logs[name].push(...chunk.toString("utf8").split("\n").filter(Boolean));
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  children.push(child);
}

async function waitFor(url: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw new Error(`${label} did not start`);
}

let failures = 0;
function check(label: string, expected: string, actual: string): void {
  const passed = expected === actual;
  if (!passed) failures += 1;
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label.padEnd(58)} expected ${expected.padEnd(22)} got ${actual}`);
}

async function http(method: string, path: string, token?: string, body?: unknown): Promise<string> {
  const response = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return String(response.status);
}

/** Opens a Socket.IO connection through the gateway and reports how the handshake ended. */
function handshake(token: string | undefined, transports?: string[]): Promise<{ outcome: string; emit: (event: string, payload: unknown) => Promise<string>; close: () => void }> {
  const socket = connect(GATEWAY, {
    path: "/socket.io",
    forceNew: true,
    reconnection: false,
    ...(transports ? { transports } : {}),
    ...(token === undefined ? {} : { auth: { token } }),
  });
  const emit = (event: string, payload: unknown) =>
    new Promise<string>((resolve) =>
      socket.timeout(3000).emit(event, payload, (error: Error | null, ack: { ok: boolean; error?: { code: string }; data?: { hostId?: string; players?: { id: string }[] } }) => {
        if (error) resolve("no answer");
        else if (!ack.ok) resolve(ack.error?.code ?? "error");
        else resolve(`ok (${ack.data?.players?.map((p) => p.id).join(", ") ?? ""})`);
      }),
    );
  return new Promise((resolve) => {
    socket.on("connect", () => resolve({ outcome: "connected", emit, close: () => socket.disconnect() }));
    socket.on("connect_error", (error) => resolve({ outcome: error.message, emit, close: () => socket.disconnect() }));
  });
}

async function main(): Promise<void> {
  if (!existsSync(GATEWAY_JAR)) throw new Error(`Build the gateway first: ${GATEWAY_JAR} not found`);
  const entra = await new FakeEntra().start();
  const auth = {
    AZURE_TENANT_ID: TEST_TENANT_ID,
    AZURE_CLIENT_ID: TEST_CLIENT_ID,
    ENTRA_JWKS_URI: entra.jwksUri,
    GUEST_TOKEN_SECRET: GUEST_SECRET,
  };
  start("battle-service", process.execPath, ["--import", "tsx", "src/server.ts"], {
    ...auth,
    PORT: String(BATTLE_PORT),
    CORS_ORIGIN: FRONTEND_ORIGIN,
    // Nothing listens there: match results are not part of this check.
    USERS_SERVICE_URL: "http://localhost:9",
  });
  start("api-gateway", "java", ["-jar", GATEWAY_JAR], {
    ...auth,
    GATEWAY_PORT: String(GATEWAY_PORT),
    BATTLE_SERVICE_URL: `http://localhost:${BATTLE_PORT}`,
    USERS_SERVICE_URL: "http://localhost:9",
    FRONTEND_ORIGIN,
  });
  await waitFor(`http://localhost:${BATTLE_PORT}/api/battles/health`, "battle-service");
  await waitFor(`${GATEWAY}/actuator/health`, "api-gateway");
  console.log(`api-gateway on ${GATEWAY} -> battle-service on http://localhost:${BATTLE_PORT}\n`);

  const ana = await entra.token({ oid: "user-ana", name: "Ana" });
  const expired = await entra.token({ oid: "user-ana", expiresInSeconds: -3600 });
  const tampered = tamperedPayload(await entra.token({ oid: "user-mallory" }), { oid: "user-ana" });
  const otherAudience = await entra.token({ oid: "user-ana", audience: "99999999-9999-4999-8999-999999999999" });

  // A room to work with, created by a registered user through the gateway.
  const created = await fetch(`${GATEWAY}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ana}` },
    body: JSON.stringify({ displayName: "Ana", hostId: "someone-else" }),
  });
  const room = (await created.json()) as { code: string; hostId: string };
  const other = (await (
    await fetch(`${GATEWAY}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await entra.token({ oid: "user-beto", name: "Beto" })}` },
      body: JSON.stringify({ displayName: "Beto" }),
    })
  ).json()) as { code: string };
  const guest = (await (
    await fetch(`${GATEWAY}/api/rooms/${room.code}/guest-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Invitado" }),
    })
  ).json()) as { token: string; playerId: string };

  console.log("HTTP through the api-gateway: POST /api/rooms (create a room)");
  check("1. absent token", "401", await http("POST", "/api/rooms", undefined, { displayName: "X" }));
  check("2. expired token", "401", await http("POST", "/api/rooms", expired, { displayName: "X" }));
  check("3. tampered token", "401", await http("POST", "/api/rooms", tampered, { displayName: "X" }));
  check("4. token for another audience", "401", await http("POST", "/api/rooms", otherAudience, { displayName: "X" }));
  check("5. guest token (out of scope)", "403", await http("POST", "/api/rooms", guest.token, { displayName: "X" }));
  check("6. valid token", "201", String(created.status));
  check("   host taken from the token, not from the body", "user-ana", room.hostId);

  console.log("\nHTTP through the api-gateway: GET /api/matches/{id} (match history)");
  const history = "/api/matches/11111111-2222-4333-8444-555555555555";
  check("1. absent token", "401", await http("GET", history));
  check("2. expired token", "401", await http("GET", history, expired));
  check("3. tampered token", "401", await http("GET", history, tampered));
  check("4. token for another audience", "401", await http("GET", history, otherAudience));
  check("5. guest token (out of scope)", "403", await http("GET", history, guest.token));
  // Accepted by the gateway and routed; users-service is not running in this check.
  check("6. valid token (routed; users-service is down here)", "500", await http("GET", history, ana));

  console.log("\nHTTP through the api-gateway: a guest and the rooms");
  check("guest reads its own room", "200", await http("GET", `/api/rooms/${room.code}`, guest.token));
  check("guest reads another room (out of scope)", "403", await http("GET", `/api/rooms/${other.code}`, guest.token));
  check("guest token for a room that does not exist", "404", await http("POST", "/api/rooms/NOROOM/guest-token", undefined, { displayName: "X" }));

  console.log("\nSocket.IO through the api-gateway: handshake");
  const refused: [string, string | undefined][] = [
    ["1. absent token", undefined],
    ["2. expired token", expired],
    ["3. tampered token", tampered],
    ["4. token for another audience", otherAudience],
    ["   expired guest token", await guestToken({ roomCode: room.code, expiresInSeconds: -3600, secret: new TextEncoder().encode(GUEST_SECRET) })],
  ];
  for (const [label, token] of refused) {
    const attempt = await handshake(token);
    check(label, "UNAUTHORIZED", attempt.outcome);
    attempt.close();
  }
  const guestSocket = await handshake(guest.token);
  check("5. guest token: handshake", "connected", guestSocket.outcome);
  check("5. guest joins another room (out of scope)", "FORBIDDEN", await guestSocket.emit("room:join", { roomCode: other.code }));
  check("   guest joins its own room", `ok (user-ana, ${guest.playerId})`, await guestSocket.emit("room:join", { roomCode: room.code }));
  const userSocket = await handshake(await entra.token({ oid: "user-carla", name: "Carla" }));
  check("6. valid token: handshake (polling, then WebSocket)", "connected", userSocket.outcome);
  check(
    "6. room:join claiming to be the host: seated as herself",
    `ok (user-ana, ${guest.playerId}, user-carla)`,
    await userSocket.emit("room:join", { roomCode: room.code, playerId: "user-ana" }),
  );
  const webSocketOnly = await handshake(await entra.token({ oid: "user-dario", name: "Darío" }), ["websocket"]);
  check("6. valid token: handshake (WebSocket only)", "connected", webSocketOnly.outcome);
  const refusedWebSocket = await handshake(undefined, ["websocket"]);
  check("1. absent token (WebSocket only)", "UNAUTHORIZED", refusedWebSocket.outcome);

  await sleep(300);
  for (const service of ["api-gateway", "battle-service"]) {
    const lines = logs[service].filter((line) => line.includes("auth.rejected")).map((line) => line.slice(line.indexOf("{")));
    console.log(`\nAudit trail written by ${service} (${lines.length} refusals):`);
    for (const line of lines) console.log(`  ${line}`);
  }
  const everything = Object.values(logs).flat().join("\n");
  const leaked = [ana, expired, tampered, otherAudience, guest.token].some((token) => everything.includes(token));
  console.log("");
  check("no token in the logs of either service", "false", String(leaked));

  if (keepAlive) {
    console.log(`\nServices kept running. Room for guests: ${room.code} (gateway ${GATEWAY}). Ctrl+C to stop.`);
    await new Promise(() => {});
  }
  for (const socket of [guestSocket, userSocket, webSocketOnly, refusedWebSocket]) socket.close();
  await entra.stop();
}

function stop(): void {
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});

main()
  .then(() => {
    console.log(failures === 0 ? "\nSEG-1 end-to-end: every check passed" : `\nSEG-1 end-to-end: ${failures} check(s) FAILED`);
    stop();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((error: unknown) => {
    console.error(error);
    stop();
    process.exit(1);
  });
