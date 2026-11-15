// Uso: node scripts/fake-entra.mjs [puerto=4010]
// Sirve las claves públicas (JWKS) del "Entra ID" falso y deja listas las variables
// que debe tener el Battle Service para aceptar los tokens de la prueba de carga.
// Déjalo corriendo en una terminal mientras dura la prueba.
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadOrCreateKey, mintEntraToken, TENANT_ID, CLIENT_ID } = require("../lib/fake-entra.cjs");

// Local manual testing only: the frontend's dev login (vite dev with VITE_DEV_LOGIN_URL) asks here
// for a token, as Microsoft would issue it after a sign-in. This server never runs outside a test
// machine; the real Entra ID is the only issuer anywhere else.
const DEV_ORIGIN = process.env.FAKE_ENTRA_DEV_ORIGIN ?? "http://localhost:5173";
const DEV_TOKEN_SECONDS = 8 * 3600;

function devToken(req, res) {
  res.setHeader("access-control-allow-origin", DEV_ORIGIN);
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 2_000) req.destroy();
  });
  req.on("end", () => {
    let input;
    try {
      input = JSON.parse(body || "{}");
    } catch {
      input = {};
    }
    const oid = typeof input.oid === "string" ? input.oid.trim().slice(0, 64) : "";
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 32) : "";
    if (!/^[A-Za-z0-9-]{3,64}$/.test(oid) || name.length === 0) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "oid (letters, digits, -) and name are required" }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      token: mintEntraToken({ oid, name, expiresInSeconds: DEV_TOKEN_SECONDS }),
      oid,
      name,
      expiresAt: new Date(Date.now() + DEV_TOKEN_SECONDS * 1000).toISOString(),
    }));
  });
}

const port = Number(process.argv[2] ?? 4010);
const key = loadOrCreateKey({ create: true });

createServer((req, res) => {
  if (req.url?.startsWith("/discovery/v2.0/keys")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [key.publicJwk] }));
    return;
  }
  if (req.url?.startsWith("/dev/token")) {
    devToken(req, res);
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(port, () => {
  console.log(`Entra ID falso (solo pruebas de carga) en http://localhost:${port}`);
  console.log("\nVariables para el Battle Service (battle-service/.env o set en CMD):\n");
  console.log(`AZURE_TENANT_ID=${TENANT_ID}`);
  console.log(`AZURE_CLIENT_ID=${CLIENT_ID}`);
  console.log(`ENTRA_JWKS_URI=http://localhost:${port}/discovery/v2.0/keys`);
  console.log("GUEST_TOKEN_SECRET=<cualquier texto de 32 o más caracteres, el mismo que use el servicio>");
});
