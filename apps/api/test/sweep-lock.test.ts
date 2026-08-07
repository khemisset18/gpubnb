import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { acquireSweepLock } from '../src/sweep-lock.js';

// Real Redis, no mocking — same philosophy as the agent's instance_lock tests: a
// distributed lock is exactly the kind of primitive that looks correct with a mock
// and is subtly wrong for real (e.g. TTL semantics, atomicity of SET NX, Lua EVAL
// return types). Each test gets its own random key so files/tests running concurrently
// never collide on Redis state.

const redisUrl = process.env.REDIS_URL ?? 'redis://:change-me@localhost:6379';
const redis = new Redis(redisUrl);

function uniqueKey(): string {
  return `test:sweep-lock:${randomBytes(8).toString('hex')}`;
}

test('1) a second acquire attempt is rejected while the first holder is still alive', async () => {
  const key = uniqueKey();
  const first = await acquireSweepLock(redis, 5_000, undefined, key);
  assert.ok(first, 'first acquire must succeed');
  const second = await acquireSweepLock(redis, 5_000, undefined, key);
  assert.equal(second, null, 'a concurrent holder must be rejected, not silently granted');
  await first!.release();
});

test('2) the lock is reacquirable immediately after an explicit release', async () => {
  const key = uniqueKey();
  const first = await acquireSweepLock(redis, 5_000, undefined, key);
  assert.ok(await first!.release());
  const second = await acquireSweepLock(redis, 5_000, undefined, key);
  assert.ok(second, 'release must actually free the key for the next acquirer');
  await second!.release();
});

test('3) an expired lock (TTL elapsed, holder never released) is acquirable by someone else', async () => {
  const key = uniqueKey();
  const first = await acquireSweepLock(redis, 150, undefined, key); // short TTL, simulates a crashed holder
  assert.ok(first);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const second = await acquireSweepLock(redis, 5_000, undefined, key);
  assert.ok(second, 'TTL expiry must self-heal a crashed/never-released lock, no manual stale-lock cleanup needed');
  await second!.release();
});

test('4) a holder whose TTL already expired can never delete a new holder\'s lock (release is compare-and-delete, not a plain DEL)', async () => {
  const key = uniqueKey();
  const first = await acquireSweepLock(redis, 150, undefined, key);
  assert.ok(first);
  await new Promise((resolve) => setTimeout(resolve, 350)); // first's TTL elapses
  const second = await acquireSweepLock(redis, 5_000, undefined, key);
  assert.ok(second, 'second holder must be able to take over after expiry');

  const releasedByFirst = await first!.release();
  assert.equal(releasedByFirst, false, 'the expired holder must not report a real release');

  const stillHeldByThird = await acquireSweepLock(redis, 5_000, undefined, key);
  assert.equal(stillHeldByThird, null, "the first holder's stale release call must not have deleted the second holder's live lock");

  await second!.release();
});

test('5) release() is idempotent: a second call on the same handle is a no-op, not an error', async () => {
  const key = uniqueKey();
  const lock = await acquireSweepLock(redis, 5_000, undefined, key);
  assert.ok(lock);
  assert.equal(await lock!.release(), true);
  assert.equal(await lock!.release(), false, 'a repeat release must not re-report success or throw');
});

test('6) two real concurrent acquire attempts on the same key: exactly one wins', async () => {
  const key = uniqueKey();
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () => acquireSweepLock(redis, 5_000, undefined, key)),
  );
  const winners = attempts.filter((lock) => lock !== null);
  assert.equal(winners.length, 1, 'exactly one of five simultaneous acquire attempts must win the lock');
  await winners[0]!.release();
});

test('7) locks on different keys never interfere with each other', async () => {
  const keyA = uniqueKey();
  const keyB = uniqueKey();
  const lockA = await acquireSweepLock(redis, 5_000, undefined, keyA);
  const lockB = await acquireSweepLock(redis, 5_000, undefined, keyB);
  assert.ok(lockA);
  assert.ok(lockB, 'a lock on an unrelated key must not be blocked by an unrelated holder');
  await Promise.all([lockA!.release(), lockB!.release()]);
});

test.after(async () => {
  await redis.quit();
});
