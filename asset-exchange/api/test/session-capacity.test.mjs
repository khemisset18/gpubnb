import test from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/session.mjs";

const record = (subject = "maker:test:001") => ({ subject, expiresAtUnixMs: 60000 });

test("refuses unbounded session-store configurations", () => {
  for (const maxSessions of [0, -1, 4097, Infinity, 1.5, "100"]) {
    assert.throws(() => createMemorySessionStore({ maxSessions }), { code: "SESSION_STORE_CAP" });
  }
});

test("refuses a new session at capacity rather than evicting active sessions", async () => {
  const store = createMemorySessionStore({ maxSessions: 2 });
  await store.put("hash-a", record("user-a"));
  await store.put("hash-b", record("user-b"));
  await assert.rejects(() => store.put("hash-c", record("user-c")), { code: "SESSION_STORE_FULL" });
  assert.equal((await store.get("hash-a")).subject, "user-a");
  assert.equal((await store.get("hash-b")).subject, "user-b");
  assert.equal(await store.get("hash-c"), null);
});

test("allows updates of existing sessions even at capacity", async () => {
  const store = createMemorySessionStore({ maxSessions: 1 });
  await store.put("same", record("before"));
  await store.put("same", record("after"));
  assert.equal((await store.get("same")).subject, "after");
});

test("delete and subject revocation free slots", async () => {
  const store = createMemorySessionStore({ maxSessions: 2 });
  await store.put("a", record("alice"));
  await store.put("b", record("bob"));
  await store.delete("a");
  await store.put("c", record("carol"));
  await store.revokeSubject("bob");
  await store.put("d", record("dave"));
  assert.equal((await store.get("d")).subject, "dave");
});

test("stored records remain isolated from caller mutation", async () => {
  const store = createMemorySessionStore({ maxSessions: 1 });
  const input = record();
  await store.put("one", input);
  input.subject = "changed";
  const read = await store.get("one");
  read.subject = "modified";
  assert.equal((await store.get("one")).subject, "maker:test:001");
});

test("default session store cannot grow beyond 4096 entries", async () => {
  const store = createMemorySessionStore();
  for (let i = 0; i < 4_096; i++) await store.put(`session-${i}`, record());
  await assert.rejects(() => store.put("session-overflow", record()), { code: "SESSION_STORE_FULL" });
  assert.equal((await store.get("session-0")).subject, "maker:test:001");
});
