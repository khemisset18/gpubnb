import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalBytes } from "../../core/src/canonical.mjs";
import { createMemorySessionStore, createSessionManager } from "../src/session.mjs";
import { createMemorySsoReplayStore } from "../src/postgres-sso-replay-store.mjs";
import { createSsoExchangeService, createSsoTicket } from "../src/sso-ticket.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });

function signedTicket(patch = {}) {
  const ticket = createSsoTicket({
    domain: "GPUBNB:ASSET-EXCHANGE:SSO:v1",
    version: 1,
    issuer: "gpubnb-core-auth",
    audience: "gpu.k.p2p",
    deploymentId: "ae-test-01",
    subject: "user:test:001",
    iatUnixMs: 1000,
    expUnixMs: 61000,
    jti: "ticket-000000000001",
    ...patch
  });
  const signature = sign(null, canonicalBytes(ticket), privateKey).toString("base64url");
  return { ticket, signature };
}

function service(overrides = {}) {
  return createSsoExchangeService({
    publicKeyPem,
    expectedIssuer: "gpubnb-core-auth",
    expectedAudience: "gpu.k.p2p",
    deploymentId: "ae-test-01",
    replayStore: createMemorySsoReplayStore(),
    sessionManager: createSessionManager({ store: createMemorySessionStore(), now: () => 2000 }),
    now: () => 2000,
    ...overrides
  });
}

test("valid signed SSO ticket creates independent Exchange session", async () => {
  const out = await service().exchange(signedTicket());
  assert.match(out.cookie, /^__Host-gpubnb-ae-session=/);
  assert.equal(typeof out.csrfToken, "string");
});

test("replay of same jti is rejected", async () => {
  const replayStore = createMemorySsoReplayStore();
  const svc = service({ replayStore });
  const value = signedTicket();
  await svc.exchange(value);
  await assert.rejects(() => svc.exchange(value));
});

test("wrong audience, deployment, expiry and signature fail closed", async () => {
  await assert.rejects(() => service().exchange(signedTicket({ audience: "other" })));
  await assert.rejects(() => service().exchange(signedTicket({ deploymentId: "ae-other-01" })));

  const expired = signedTicket({ iatUnixMs: 1000, expUnixMs: 1500, jti: "ticket-000000000002" });
  await assert.rejects(() => service().exchange(expired));

  const invalid = signedTicket({ jti: "ticket-000000000003" });
  invalid.signature = "A".repeat(86);
  await assert.rejects(() => service().exchange(invalid));
});

test("unexpected claims are rejected instead of silently propagated", () => {
  assert.throws(() => createSsoTicket({
    ...signedTicket({ jti: "ticket-000000000004" }).ticket,
    kycApproved: true
  }));
});
