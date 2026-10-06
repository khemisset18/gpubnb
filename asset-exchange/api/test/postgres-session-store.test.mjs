import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../src/postgres-session-store.mjs";

function fakePool(script = []) {
  const calls = [];
  const results = [...script];
  const client = {
    async query(arg) {
      calls.push(arg);
      const next = results.shift();
      return next ?? { rows: [] };
    },
    release() { calls.push("RELEASE"); }
  };
  return { calls, async connect() { calls.push("CONNECT"); return client; } };
}

test("postgres session store persists only hashes and parameterizes values", async () => {
  const pool = fakePool();
  const store = createPostgresSessionStore({ pool, deploymentId: "ae-test-01" });
  await store.put("a".repeat(64), {
    subject: "maker:test:001",
    authnMethod: "EXCHANGE_SESSION",
    csrfHash: "b".repeat(64),
    createdAtUnixMs: 1000,
    expiresAtUnixMs: 61000
  });
  const query = pool.calls.find((x) => typeof x === "object");
  assert.equal(query.values[0], "a".repeat(64));
  assert.equal(query.values[4], "b".repeat(64));
  assert.equal(query.text.includes("maker:test:001"), false);
  assert.equal(pool.calls.at(-1), "RELEASE");
});

test("postgres session store reads active session scoped to deployment", async () => {
  const pool = fakePool([{ rows: [{
    subject: "maker:test:001",
    authn_method: "EXCHANGE_SESSION",
    csrf_hash: "b".repeat(64),
    created_at: new Date(1000),
    expires_at: new Date(61000)
  }] }]);
  const store = createPostgresSessionStore({ pool, deploymentId: "ae-test-01" });
  const row = await store.get("a".repeat(64));
  assert.equal(row.subject, "maker:test:001");
  const query = pool.calls.find((x) => typeof x === "object");
  assert.deepEqual(query.values, ["a".repeat(64), "ae-test-01"]);
});

test("delete revokes instead of physically deleting audit row", async () => {
  const pool = fakePool();
  const store = createPostgresSessionStore({ pool, deploymentId: "ae-test-01" });
  await store.delete("a".repeat(64));
  const query = pool.calls.find((x) => typeof x === "object");
  assert.match(query.text, /UPDATE asset_exchange\.exchange_sessions/);
  assert.equal(/DELETE FROM/i.test(query.text), false);
});
