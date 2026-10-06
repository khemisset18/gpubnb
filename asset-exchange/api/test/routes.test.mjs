import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApiServer } from "../src/server.mjs";
import { createBusinessRouter } from "../src/routes.mjs";
import { createMemorySessionStore, createSessionManager } from "../src/session.mjs";
import { createMemoryFixedWindowRateLimiter } from "../src/rate-limit.mjs";

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
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
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
  const server = createApiServer({ businessRouter: router });
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
  const server = createApiServer({ businessRouter: router });
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
  const server = createApiServer({ businessRouter: router });
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
  const server = createApiServer({ businessRouter: router });
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
