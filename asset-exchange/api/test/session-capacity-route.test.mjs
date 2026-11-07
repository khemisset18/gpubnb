import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { DomainError } from "../../core/src/errors.mjs";
import { createBusinessRouter } from "../src/routes.mjs";

test("Exchange returns 503 without exposing internals when in-memory session store is full", async () => {
  const router = createBusinessRouter({
    sessionManager: {
      authenticateRequest: async () => { throw new Error("not expected"); },
      assertCsrf: async () => {},
      revokeRequest: async () => {}
    },
    offerService: { publishOffer: async () => {} },
    ssoService: { exchange: async () => { throw new DomainError("SESSION_STORE_FULL", "private store details"); } },
    rateLimiter: { consume: async () => ({ allowed: true, remaining: 0 }) },
    allowedOrigins: ["https://exchange.example"]
  });
  const req = Readable.from([Buffer.from('{"ticket":{},"signature":"opaque"}')]);
  req.method = "POST";
  req.url = "/v1/session/exchange";
  req.headers = { origin: "https://exchange.example", "content-type": "application/json" };
  req.socket = { remoteAddress: "127.0.0.1" };
  const responses = [];
  assert.equal(await router(req, (status, body) => responses.push({ status, body })), true);
  assert.deepEqual(responses, [{ status: 503, body: { error: "service_unavailable" } }]);
});
