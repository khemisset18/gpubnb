import test from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore, createSessionManager, COOKIE_NAME, parseCookieHeader } from "../src/session.mjs";

function req(cookie, csrf) {
  return { headers: { cookie, ...(csrf ? { "x-csrf-token": csrf } : {}) } };
}

test("session cookie is hardened and store never receives raw session id", async () => {
  const writes = [];
  const backing = createMemorySessionStore();
  const store = {
    async put(key, value) { writes.push([key, value]); return backing.put(key, value); },
    get: backing.get, delete: backing.delete
  };
  const manager = createSessionManager({ store, now: () => 1000 });
  const issued = await manager.issue({ subject: "maker:test:001" });
  assert.match(issued.cookie, new RegExp(`^${COOKIE_NAME}=`));
  assert.match(issued.cookie, /Secure/);
  assert.match(issued.cookie, /HttpOnly/);
  assert.match(issued.cookie, /SameSite=Strict/);
  const raw = parseCookieHeader(issued.cookie.split(";")[0]).get(COOKIE_NAME);
  assert.equal(writes[0][0].includes(raw), false);
  assert.equal(writes[0][0].length, 64);
});

test("csrf is bound to session and wrong token is rejected", async () => {
  const store = createMemorySessionStore();
  const manager = createSessionManager({ store, now: () => 1000 });
  const issued = await manager.issue({ subject: "maker:test:001" });
  const cookie = issued.cookie.split(";")[0];
  const actor = await manager.authenticateRequest(req(cookie));
  await manager.assertCsrf(req(cookie, issued.csrfToken), actor);
  await assert.rejects(() => manager.assertCsrf(req(cookie, "A".repeat(43)), actor));
});

test("expired session is rejected and removed", async () => {
  let now = 1000;
  const store = createMemorySessionStore();
  const manager = createSessionManager({ store, ttlMs: 60_000, now: () => now });
  const issued = await manager.issue({ subject: "maker:test:001" });
  const cookie = issued.cookie.split(";")[0];
  now = 61_001;
  await assert.rejects(() => manager.authenticateRequest(req(cookie)));
});

test("duplicate cookie names fail closed", () => {
  assert.throws(() => parseCookieHeader("a=1; a=2"));
});
