import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AuthError } from "../src/application/auth/AuthIdentity.js";
import { PERSONAL_ACCOUNTS_TENANT } from "../src/infrastructure/auth/JwtTokenVerifier.js";
import { FakeEntra, TEST_TENANT_ID } from "./support/auth.js";

/**
 * SEG-1 with a multi-tenant application (AZURE_TENANT_ID=common or
 * organizations): users of any organization sign in without being invited.
 * Signature, expiry, audience and issuer are still checked; the issuer must be
 * an Entra ID v2.0 issuer for the very tenant named in the token's `tid`.
 */
const entra = new FakeEntra();
const OTHER_TENANT = "33333333-3333-4333-8333-333333333333";

before(() => entra.start());
after(() => entra.stop());

async function reason(promise: Promise<unknown>): Promise<string> {
  const error = (await promise.then(() => assert.fail("the token was accepted"), (e: unknown) => e)) as AuthError;
  assert.equal(error.code, "UNAUTHORIZED");
  return error.reason;
}

describe('SEG-1 multi-tenant ("common"): any organization and personal accounts', () => {
  const verifier = () => entra.multiTenantVerifier(true);

  it("accepts a user of another organization, without inviting them", async () => {
    const identity = await verifier().verify(await entra.token({ oid: "user-escuela", name: "Sebastián", tenantId: OTHER_TENANT }));
    assert.deepEqual(identity, { kind: "user", playerId: "user-escuela", displayName: "Sebastián" });
  });

  it("accepts a user of the home tenant and a personal Microsoft account", async () => {
    assert.equal((await verifier().verify(await entra.token({ oid: "home", tenantId: TEST_TENANT_ID }))).playerId, "home");
    assert.equal((await verifier().verify(await entra.token({ oid: "personal", tenantId: PERSONAL_ACCOUNTS_TENANT }))).playerId, "personal");
  });

  it("still refuses the 6 cases: expired, tampered, other audience, foreign issuer...", async () => {
    const v = verifier();
    assert.equal(await reason(v.verify(await entra.token({ tenantId: OTHER_TENANT, expiresInSeconds: -3600 }))), "expired_token");
    assert.equal(await reason(v.verify(await entra.forgedToken({ tenantId: OTHER_TENANT }))), "invalid_signature");
    assert.equal(await reason(v.verify(await entra.token({ tenantId: OTHER_TENANT, audience: "another-api" }))), "wrong_audience");
    assert.equal(await reason(v.verify(await entra.token({ issuer: "https://evil.example/v2.0" }))), "wrong_issuer");
    // An Entra-looking issuer that is not a v2.0 tenant issuer.
    assert.equal(await reason(v.verify(await entra.token({ issuer: "https://login.microsoftonline.com/common/v2.0" }))), "wrong_issuer");
  });

  it("refuses a token whose issuer names a tenant other than its tid", async () => {
    const mismatched = await entra.token({ tenantId: OTHER_TENANT, issuer: `https://login.microsoftonline.com/${TEST_TENANT_ID}/v2.0` });
    assert.equal(await reason(verifier().verify(mismatched)), "wrong_issuer");
  });
});

describe('SEG-1 multi-tenant ("organizations"): any organization, no personal accounts', () => {
  it("accepts another organization and refuses personal accounts", async () => {
    const verifier = entra.multiTenantVerifier(false);
    assert.equal((await verifier.verify(await entra.token({ oid: "org-user", tenantId: OTHER_TENANT }))).playerId, "org-user");
    assert.equal(await reason(verifier.verify(await entra.token({ tenantId: PERSONAL_ACCOUNTS_TENANT }))), "wrong_issuer");
  });
});
