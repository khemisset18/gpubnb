import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { createApiServer } from "../src/server.mjs";
import { createBusinessRouter } from "../src/routes.mjs";
import { createMemorySessionStore, createSessionManager } from "../src/session.mjs";
import { createMemoryFixedWindowRateLimiter } from "../src/rate-limit.mjs";
import { canonicalBytes } from "../../core/src/canonical.mjs";
import { createMemorySsoReplayStore } from "../src/postgres-sso-replay-store.mjs";
import { createSsoExchangeService, createSsoTicket } from "../src/sso-ticket.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function request(port, { path, body, cookie, csrf, origin = "https://exchange.example", fetchSite = "same-origin", idempotency = "idempotency-key-001" }) {
  const payload = body === undefined ? null : Buffer.from(body, "utf8");
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method: "POST", path,
      headers: {
        host: "asset-exchange.test",
        ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
        ...(origin ? { origin } : {}),
        ...(fetchSite ? { "sec-fetch-site": fetchSite } : {}),
        "idempotency-key": idempotency
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("business route requires session and csrf before service mutation", async () => {
  const calls = [];
  const sessionManager = createSessionManager({ store: createMemorySessionStore() });
  const router = createBusinessRouter({
    sessionManager,
    rateLimiter: createMemoryFixedWindowRateLimiter(),
    allowedOrigins: ["https://exchange.example"],
    offerService: {
      async publishOffer(v) { calls.push(v); return { status: "OPEN" }; },
      async cancelOffer() { throw new Error("unexpected"); },
      async acceptOffer() { throw new Error("unexpected"); }
    }
  });
  const server = createApiServer({ businessRouter: router, allowedHosts: ["asset-exchange.test"] });
  const port = await listen(server);
  try {
    const res = await request(port, { path: "/v1/offers", body: '{"offer":{},"signature":"sig"}' });
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  } finally { await new Promise((r) => server.close(r)); }
});

test("valid session+csrf routes publish request and duplicate JSON keys are rejected", async () => {
  const calls = [];
  const sessionManager = createSessionManager({ store: createMemorySessionStore() });
  const issued = await sessionManager.issue({ subject: "maker:test:001" });
  const cookie = issued.cookie.split(";")[0];
  const router = createBusinessRouter({
    sessionManager,
    rateLimiter: createMemoryFixedWindowRateLimiter(),
    allowedOrigins: ["https://exchange.example"],
    offerService: {
      async publishOffer(v) { calls.push(v); return { status: "OPEN", offerId: "offer-1" }; },
      async cancelOffer() { throw new Error("unexpected"); },
      async acceptOffer() { throw new Error("unexpected"); }
    }
  });
  const server = createApiServer({ businessRouter: router, allowedHosts: ["asset-exchange.test"] });
  const port = await listen(server);
  try {
    const good = await request(port, {
      path: "/v1/offers",
      cookie, csrf: issued.csrfToken,
      body: '{"offer":{"offerId":"offer-1"},"signature":"sig"}'
    });
    assert.equal(good.status, 201);
    assert.equal(calls.length, 1);

    const bad = await request(port, {
      path: "/v1/offers",
      cookie, csrf: issued.csrfToken,
      idempotency: "idempotency-key-002",
      body: '{"offer":{"a":1,"a":2},"signature":"sig"}'
    });
    assert.equal(bad.status, 400);
    assert.equal(calls.length, 1);
  } finally { await new Promise((r) => server.close(r)); }
});

test("rate limit blocks repeated business flow", async () => {
  const sessionManager = createSessionManager({ store: createMemorySessionStore() });
  const issued = await sessionManager.issue({ subject: "maker:test:001" });
  const cookie = issued.cookie.split(";")[0];
  const router = createBusinessRouter({
    sessionManager,
    rateLimiter: createMemoryFixedWindowRateLimiter({ limit: 1 }),
    allowedOrigins: ["https://exchange.example"],
    offerService: {
      async publishOffer() { return { status: "OPEN" }; },
      async cancelOffer() { throw new Error("unexpected"); },
      async acceptOffer() { throw new Error("unexpected"); }
    }
  });
  const server = createApiServer({ businessRouter: router, allowedHosts: ["asset-exchange.test"] });
  const port = await listen(server);
  try {
    const first = await request(port, { path: "/v1/offers", cookie, csrf: issued.csrfToken, body: '{"offer":{},"signature":"sig"}' });
    const second = await request(port, { path: "/v1/offers", cookie, csrf: issued.csrfToken, idempotency: "idempotency-key-003", body: '{"offer":{},"signature":"sig"}' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 429);
  } finally { await new Promise((r) => server.close(r)); }
});

test("mutating business routes reject untrusted or cross-site origins", async () => {
  const calls = [];
  const sessionManager = createSessionManager({ store: createMemorySessionStore() });
  const issued = await sessionManager.issue({ subject: "maker:test:001" });
  const cookie = issued.cookie.split(";")[0];
  const router = createBusinessRouter({
    sessionManager,
    rateLimiter: createMemoryFixedWindowRateLimiter(),
    allowedOrigins: ["https://exchange.example"],
    offerService: {
      async publishOffer(v) { calls.push(v); return { status: "OPEN" }; },
      async cancelOffer() { throw new Error("unexpected"); },
      async acceptOffer() { throw new Error("unexpected"); }
    }
  });
  const server = createApiServer({ businessRouter: router, allowedHosts: ["asset-exchange.test"] });
  const port = await listen(server);
  try {
    const evil = await request(port, {
      path: "/v1/offers",
      cookie, csrf: issued.csrfToken,
      origin: "https://evil.example",
      body: '{"offer":{},"signature":"sig"}'
    });
    assert.equal(evil.status, 403);

    const crossSite = await request(port, {
      path: "/v1/offers",
      cookie, csrf: issued.csrfToken,
      fetchSite: "cross-site",
      body: '{"offer":{},"signature":"sig"}'
    });
    assert.equal(crossSite.status, 403);
    assert.equal(calls.length, 0);
  } finally { await new Promise((r) => server.close(r)); }
});

test("logout revokes current session and expires hardened cookie", async () => {
  const store = createMemorySessionStore();
  const sessionManager = createSessionManager({ store });
  const issued = await sessionManager.issue({ subject: "maker:test:001" });
  const cookie = issued.cookie.split(";")[0];
  const router = createBusinessRouter({
    sessionManager,
    rateLimiter: createMemoryFixedWindowRateLimiter(),
    allowedOrigins: ["https://exchange.example"],
    offerService: {
      async publishOffer() { throw new Error("unexpected"); },
      async cancelOffer() { throw new Error("unexpected"); },
      async acceptOffer() { throw new Error("unexpected"); }
    }
  });
  const server = createApiServer({ businessRouter: router, allowedHosts: ["asset-exchange.test"] });
  const port = await listen(server);
  try {
    const out = await request(port, {
      path: "/v1/session/logout",
      cookie,
      csrf: issued.csrfToken
    });
    assert.equal(out.status, 200);
    assert.match(out.headers["set-cookie"][0], /Max-Age=0/);

    const after = await request(port, {
      path: "/v1/offers",
      cookie,
      csrf: issued.csrfToken,
      body: '{"offer":{},"signature":"sig"}'
    });
    assert.equal(after.status, 401);
  } finally { await new Promise((r) => server.close(r)); }
});

test("signed SSO HTTP exchange creates session and replay is rejected", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const store = createMemorySessionStore();
  const sessionManager = createSessionManager({ store, now: () => 2000 });
  const replayStore = createMemorySsoReplayStore();
  const ssoService = createSsoExchangeService({
    publicKeyPem,
    expectedIssuer: "gpubnb-core-auth",
    expectedAudience: "gpu.k.p2p",
    deploymentId: "ae-test-01",
    replayStore,
    sessionManager,
    now: () => 2000
  });
  const ticket = createSsoTicket({
    domain: "GPUBNB:ASSET-EXCHANGE:SSO:v1",
    version: 1,
    issuer: "gpubnb-core-auth",
    audience: "gpu.k.p2p",
    deploymentId: "ae-test-01",
    subject: "user:test:001",
    iatUnixMs: 1000,
    expUnixMs: 61000,
    jti: "route-ticket-00000001"
  });
  const signature = sign(null, canonicalBytes(ticket), privateKey).toString("base64url");

  const router = createBusinessRouter({
    sessionManager,
    ssoService,
    rateLimiter: createMemoryFixedWindowRateLimiter(),
    allowedOrigins: ["https://exchange.example"],
    offerService: {
      async publishOffer() { throw new Error("unexpected"); },
      async cancelOffer() { throw new Error("unexpected"); },
      async acceptOffer() { throw new Error("unexpected"); }
    }
  });

  const server = createApiServer({ businessRouter: router, allowedHosts: ["asset-exchange.test"] });
  const port = await listen(server);
  const body = JSON.stringify({ ticket, signature });
  try {
    const first = await request(port, { path: "/v1/session/exchange", body });
    assert.equal(first.status, 200);
    assert.match(first.headers["set-cookie"][0], /^__Host-gpubnb-ae-session=/);
    const parsed = JSON.parse(first.body);
    assert.equal(parsed.status, "session_created");
    assert.equal(typeof parsed.csrfToken, "string");

    const replay = await request(port, { path: "/v1/session/exchange", body });
    assert.equal(replay.status, 401);
  } finally { await new Promise((r) => server.close(r)); }
});

test("admin fee routes bind WYSIWYS intent to authenticated session subject", async () => {
  const sessionManager = createSessionManager({ store: createMemorySessionStore() });
  const issued = await sessionManager.issue({ subject: "owner:test:001" });
  const cookie = issued.cookie.split(";")[0];
  const calls = [];
  const adminFeeService = {
    async createFeeChallenge(input) {
      calls.push(["challenge", input]);
      return {
        intent: { actorSubject: input.actorSubject, policy: input.proposedPolicy },
        challengeHash: "a".repeat(64)
      };
    },
    async activateFeePolicy(input) {
      calls.push(["activate", input]);
      return { status: "ACTIVE", rateBps: input.intent.policy.rateBps };
    }
  };
  const router = createBusinessRouter({
    sessionManager,
    adminFeeService,
    rateLimiter: createMemoryFixedWindowRateLimiter(),
    allowedOrigins: ["https://exchange.example"],
    offerService: {
      async publishOffer() { throw new Error("unexpected"); },
      async cancelOffer() { throw new Error("unexpected"); },
      async acceptOffer() { throw new Error("unexpected"); }
    }
  });
  const server = createApiServer({ businessRouter: router, allowedHosts: ["asset-exchange.test"] });
  const port = await listen(server);
  const policy = {
    policyId: "owner-fee-v2",
    version: 2,
    rateBps: 75,
    payerRole: "TAKER",
    feeAssetKey: "bitcoin|regtest|NATIVE|BTC_NATIVE|8",
    recipient: "treasury:test"
  };
  try {
    const challenge = await request(port, {
      path: "/v1/admin/fee-policy/challenge",
      cookie,
      csrf: issued.csrfToken,
      body: JSON.stringify({ policy })
    });
    assert.equal(challenge.status, 200);
    assert.equal(calls[0][1].actorSubject, "owner:test:001");

    const parsed = JSON.parse(challenge.body);
    const activate = await request(port, {
      path: "/v1/admin/fee-policy/activate",
      cookie,
      csrf: issued.csrfToken,
      body: JSON.stringify({ intent: parsed.intent, assertion: { opaque: true } })
    });
    assert.equal(activate.status, 200);
    assert.equal(calls[1][0], "activate");

    const mismatch = await request(port, {
      path: "/v1/admin/fee-policy/activate",
      cookie,
      csrf: issued.csrfToken,
      idempotency: "idempotency-key-admin-2",
      body: JSON.stringify({
        intent: { ...parsed.intent, actorSubject: "other:test:999" },
        assertion: { opaque: true }
      })
    });
    assert.equal(mismatch.status, 403);
    assert.equal(calls.filter(([name]) => name === "activate").length, 1);
  } finally { await new Promise((r) => server.close(r)); }
});


test("cancel route requires signed JSON intent and binds path offer id", async () => {
  const calls = [];
  const sessionManager = createSessionManager({ store: createMemorySessionStore() });
  const issued = await sessionManager.issue({ subject: "maker:test:001" });
  const cookie = issued.cookie.split(";")[0];
  const router = createBusinessRouter({
    sessionManager,
    rateLimiter: createMemoryFixedWindowRateLimiter(),
    allowedOrigins: ["https://exchange.example"],
    offerService: {
      async publishOffer() { throw new Error("unexpected"); },
      async acceptOffer() { throw new Error("unexpected"); },
      async cancelOffer(v) { calls.push(v); return { status: "CANCELLED", offerId: v.cancellation.offerId }; }
    }
  });
  const server = createApiServer({ businessRouter: router, allowedHosts: ["asset-exchange.test"] });
  const port = await listen(server);
  const cancellation = {
    offerId: "offer-00000001",
    deploymentId: "ae-test-01",
    maker: "maker:test:001",
    offerHash: "a".repeat(64),
    cancelledAtUnixMs: 1000,
    expiryUnixMs: 2000,
    nonce: "cancelNonce000001",
    policyEpoch: 7
  };
  try {
    const good = await request(port, {
      path: "/v1/offers/offer-00000001/cancel",
      cookie,
      csrf: issued.csrfToken,
      body: JSON.stringify({ cancellation, signature: "sig" })
    });
    assert.equal(good.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signature, "sig");

    const mismatch = await request(port, {
      path: "/v1/offers/offer-00000002/cancel",
      cookie,
      csrf: issued.csrfToken,
      idempotency: "idempotency-key-cancel-2",
      body: JSON.stringify({ cancellation, signature: "sig" })
    });
    assert.equal(mismatch.status, 400);
    assert.equal(calls.length, 1);

    const empty = await request(port, {
      path: "/v1/offers/offer-00000001/cancel",
      cookie,
      csrf: issued.csrfToken,
      idempotency: "idempotency-key-cancel-3"
    });
    assert.equal(empty.status, 400);
    assert.equal(calls.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
