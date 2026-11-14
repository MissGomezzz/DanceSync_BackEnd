"use strict";
/**
 * Sustituto local de Microsoft Entra ID para las pruebas de carga (SEG-1 activo).
 *
 * Un par de claves RSA guardado en .keys/fake-entra.json: la parte pública la sirve
 * scripts/fake-entra.mjs como JWKS (igual que el endpoint de claves del tenant) y la
 * privada la usa el bot para firmar tokens RS256 con la forma que emite Entra ID v2.0.
 * El Battle Service valida estos tokens con su verificador real, apuntando ENTRA_JWKS_URI aquí.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const KEY_FILE = process.env.FAKE_ENTRA_KEY || path.join(__dirname, "..", ".keys", "fake-entra.json");
const TENANT_ID = process.env.FAKE_TENANT_ID || "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = process.env.FAKE_CLIENT_ID || "22222222-2222-4222-8222-222222222222";
const KID = "dancesync-load-key-1";

const b64url = (data) => Buffer.from(data).toString("base64url");

/** Carga la clave; si no existe, la genera (solo scripts/fake-entra.mjs debería hacerlo). */
function loadOrCreateKey({ create = false } = {}) {
  if (fs.existsSync(KEY_FILE)) return JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  if (!create) throw new Error(`No existe ${KEY_FILE}. Ejecuta primero: node scripts/fake-entra.mjs`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = {
    kid: KID,
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicJwk: { ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" },
  };
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify(key, null, 2));
  return key;
}

let cached = null;

/** Token de acceso como lo emite Entra ID v2.0 para la API (RS256). */
function mintEntraToken({ oid, name, expiresInSeconds = 3600 }) {
  cached ??= loadOrCreateKey();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: cached.kid };
  const payload = {
    iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    aud: CLIENT_ID,
    sub: `sub-of-${oid}`,
    oid,
    name,
    tid: TENANT_ID,
    scp: "access_as_user",
    ver: "2.0",
    iat: now - 60,
    nbf: now - 60,
    exp: now + expiresInSeconds,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), cached.privatePem);
  return `${signingInput}.${b64url(signature)}`;
}

module.exports = { loadOrCreateKey, mintEntraToken, TENANT_ID, CLIENT_ID, KEY_FILE };
