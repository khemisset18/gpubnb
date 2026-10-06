import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresSsoReplayStore } from "../src/postgres-sso-replay-store.mjs";

test("postgres SSO replay store uses atomic INSERT ON CONFLICT and deployment scope", async () => {
  const calls = [];
  const client = {
    async query(q) { calls.push(q); return { rows: [{ jti: "ticket-000000000001" }] }; },
    release() { calls.push("RELEASE"); }
  };
  const pool = { async connect() { return client; } };
  const store = createPostgresSsoReplayStore({ pool, deploymentId: "ae-test-01" });
  const consumed = await store.consume({
    jti: "ticket-000000000001",
    issuer: "gpubnb-core-auth",
    subject: "user:test:001",
    expiresAtUnixMs: 61000
  });
  assert.equal(consumed, true);
  assert.match(calls[0].text, /ON CONFLICT \(deployment_id, jti\) DO NOTHING/);
  assert.deepEqual(calls[0].values.slice(0, 4), ["ae-test-01","ticket-000000000001","gpubnb-core-auth","user:test:001"]);
  assert.equal(calls.at(-1), "RELEASE");
});
