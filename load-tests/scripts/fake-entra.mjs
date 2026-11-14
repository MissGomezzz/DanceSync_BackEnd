// Uso: node scripts/fake-entra.mjs [puerto=4010]
// Sirve las claves públicas (JWKS) del "Entra ID" falso y deja listas las variables
// que debe tener el Battle Service para aceptar los tokens de la prueba de carga.
// Déjalo corriendo en una terminal mientras dura la prueba.
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadOrCreateKey, TENANT_ID, CLIENT_ID } = require("../lib/fake-entra.cjs");

const port = Number(process.argv[2] ?? 4010);
const key = loadOrCreateKey({ create: true });

createServer((req, res) => {
  if (req.url?.startsWith("/discovery/v2.0/keys")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [key.publicJwk] }));
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
