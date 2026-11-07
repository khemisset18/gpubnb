import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryFixedWindowRateLimiter } from "../src/rate-limit.mjs";

const deny = { allowed: false, remaining: 0 };

test("fixed window preserves per-key quota and resets at its deadline", async () => {
  let time = 1_000;
  const limiter = createMemoryFixedWindowRateLimiter({ limit: 2, windowMs: 1_000, now: () => time });
  assert.deepEqual(await limiter.consume("alice"), { allowed: true, remaining: 1 });
  assert.deepEqual(await limiter.consume("alice"), { allowed: true, remaining: 0 });
  assert.deepEqual(await limiter.consume("alice"), deny);
  time = 2_000;
  assert.deepEqual(await limiter.consume("alice"), { allowed: true, remaining: 1 });
});

test("capacity failure does not evict live buckets or reset quotas", async () => {
  const limiter = createMemoryFixedWindowRateLimiter({ limit: 2, windowMs: 1_000, maxBuckets: 2, now: () => 1_000 });
  await limiter.consume("a");
  await limiter.consume("b");
  assert.deepEqual(await limiter.consume("c"), deny);
  assert.deepEqual(await limiter.consume("a"), { allowed: true, remaining: 0 });
  assert.deepEqual(await limiter.consume("a"), deny);
  assert.deepEqual(await limiter.consume("c"), deny);
});

test("expired buckets are reclaimed without resetting other live quotas", async () => {
  let time = 1_000;
  const limiter = createMemoryFixedWindowRateLimiter({ limit: 2, windowMs: 1_000, maxBuckets: 2, now: () => time });
  await limiter.consume("a");
  time = 1_500;
  await limiter.consume("b");
  time = 2_000;
  assert.deepEqual(await limiter.consume("c"), { allowed: true, remaining: 1 });
  assert.deepEqual(await limiter.consume("b"), { allowed: true, remaining: 0 });
  assert.deepEqual(await limiter.consume("c"), { allowed: true, remaining: 0 });
  assert.deepEqual(await limiter.consume("d"), deny);
});

test("expired existing key moves to the back of expiry order", async () => {
  let time = 1_000;
  const limiter = createMemoryFixedWindowRateLimiter({ limit: 1, windowMs: 1_000, maxBuckets: 2, now: () => time });
  await limiter.consume("a");
  time = 1_500;
  await limiter.consume("b");
  time = 2_000;
  assert.equal((await limiter.consume("a")).allowed, true);
  time = 2_500;
  assert.equal((await limiter.consume("c")).allowed, true);
  assert.deepEqual(await limiter.consume("d"), deny);
  assert.deepEqual(await limiter.consume("a"), deny);
});

test("rollback and invalid clock fail closed without mutating active buckets", async () => {
  let time = 1_000;
  const limiter = createMemoryFixedWindowRateLimiter({ limit: 2, windowMs: 1_000, maxBuckets: 2, now: () => time });
  await limiter.consume("a");
  time = 999;
  await assert.rejects(limiter.consume("new"), { code: "RATE_CLOCK_ROLLBACK" });
  time = 1_000;
  assert.deepEqual(await limiter.consume("a"), { allowed: true, remaining: 0 });
  assert.throws(() => createMemoryFixedWindowRateLimiter({ now: false }), { code: "RATE_CLOCK_CONFIG" });
  const invalid = createMemoryFixedWindowRateLimiter({ now: () => Infinity });
  await assert.rejects(invalid.consume("b"), { code: "RATE_CLOCK" });
  const overflow = createMemoryFixedWindowRateLimiter({ now: () => Number.MAX_SAFE_INTEGER });
  await assert.rejects(overflow.consume("b"), { code: "RATE_CLOCK_RANGE" });
});

test("rejects unsafe capacity and key configurations", async () => {
  for (const maxBuckets of [0, -1, 4097, Infinity, 0.5, "100"]) {
    assert.throws(() => createMemoryFixedWindowRateLimiter({ maxBuckets }), { code: "RATE_BUCKET_CONFIG" });
  }
  const limiter = createMemoryFixedWindowRateLimiter();
  await assert.rejects(limiter.consume(""), { code: "RATE_KEY" });
  await assert.rejects(limiter.consume("x".repeat(513)), { code: "RATE_KEY" });
});

test("default capacity stays bounded at 4096 identities", async () => {
  const limiter = createMemoryFixedWindowRateLimiter({ limit: 1, now: () => 1_000 });
  for (let i = 0; i < 4_096; i++) assert.equal((await limiter.consume(`key-${i}`)).allowed, true);
  assert.deepEqual(await limiter.consume("key-overflow"), deny);
  assert.deepEqual(await limiter.consume("key-0"), deny);
});
