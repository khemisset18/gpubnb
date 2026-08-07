import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';

// Regression for RC1 risk R2: POST /internal/sweep-offline previously only ran when
// something happened to call it by hand — nothing actually scheduled it. These tests
// cover the lock-guarded runSweepCycle that both the dedicated sweep-scheduler.ts
// process and the manual HTTP trigger now share, using a real Redis (no mocking of
// lock semantics) and a minimal fake Prisma client (the sweep functions' own
// correctness — idempotence, no double transitions/refunds/events — is already
// covered by offline-sweep.test.ts and job-staleness-sweep.test.ts).

// sweep-cycle.ts imports config.ts, which parses process.env at module-load time.
// This is the only test file that exercises that import chain in isolation, so fill
// in the minimum valid values only if they're not already set (e.g. by CI/.env),
// and import the module under test dynamically, after the env is guaranteed set.
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://:change-me@localhost:6379';
process.env.SESSION_SECRET ??= 'x'.repeat(32);
process.env.INTERNAL_SERVICE_TOKEN ??= 'x'.repeat(32);
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';

const { runSweepCycle } = await import('../src/sweep-cycle.js');
const { acquireSweepLock } = await import('../src/sweep-lock.js');

const redisUrl = process.env.REDIS_URL;
const redis = new Redis(redisUrl);

function uniqueKey(): string {
  return `test:sweep-cycle:${randomBytes(8).toString('hex')}`;
}

// Both sweepOfflineMachines and sweepStaleJobs short-circuit to an empty, no-op
// result as soon as their first findMany call returns nothing, so a fake this thin is
// enough to exercise runSweepCycle's own lock/outcome logic without a real database.
function idleDb(): PrismaClient {
  const tx = {
    machine: { findMany: async () => [] },
    job: { findMany: async () => [] },
  };
  const db = { $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) };
  return db as unknown as PrismaClient;
}

function dbThatThrows(message: string): PrismaClient {
  const db = { $transaction: async () => { throw new Error(message); } };
  return db as unknown as PrismaClient;
}

const NOW = new Date('2026-08-07T10:00:00.000Z');

test('1) an idle system completes a cycle and releases the lock afterward', async () => {
  const key = uniqueKey();
  const result = await runSweepCycle(idleDb(), redis, NOW, key);
  assert.equal(result.outcome, 'ran');
  // Lock must be free again: a fresh acquire on the same key must succeed immediately.
  const lock = await acquireSweepLock(redis, 5_000, undefined, key);
  assert.ok(lock, 'runSweepCycle must release its lock once the cycle finishes');
  await lock!.release();
});

test('2) a cycle is skipped, not duplicated, while another holder already owns the lock', async () => {
  const key = uniqueKey();
  const externalHolder = await acquireSweepLock(redis, 5_000, undefined, key);
  assert.ok(externalHolder);
  const result = await runSweepCycle(idleDb(), redis, NOW, key);
  assert.deepEqual(result, { outcome: 'lock_held' });
  await externalHolder!.release();
});

test('3) two instances calling runSweepCycle at the same instant: exactly one actually runs', async () => {
  const key = uniqueKey();
  const [a, b] = await Promise.all([
    runSweepCycle(idleDb(), redis, NOW, key),
    runSweepCycle(idleDb(), redis, NOW, key),
  ]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ['lock_held', 'ran'], 'exactly one of two simultaneous starts must run, the other must be skipped, never both running');
});

test('4) a DB failure mid-cycle is reported as failed, not thrown, and still releases the lock', async () => {
  const key = uniqueKey();
  const result = await runSweepCycle(dbThatThrows('connection terminated unexpectedly'), redis, NOW, key);
  assert.equal(result.outcome, 'failed');
  if (result.outcome === 'failed') {
    assert.ok(result.error instanceof Error);
    assert.match((result.error as Error).message, /connection terminated/);
  }
  const lock = await acquireSweepLock(redis, 5_000, undefined, key);
  assert.ok(lock, 'a failed cycle must not leak the lock');
  await lock!.release();
});

test('5) a Redis outage during lock acquisition is reported as failed, not thrown', async () => {
  const key = uniqueKey();
  const unreachable = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 1 });
  unreachable.on('error', () => {}); // expected: this client is deliberately unreachable
  const result = await runSweepCycle(idleDb(), unreachable, NOW, key);
  assert.equal(result.outcome, 'failed');
  await unreachable.quit().catch(() => {});
});

test('6) recovery on the next cycle: a failed cycle does not prevent the following cycle from running normally', async () => {
  const key = uniqueKey();
  const failed = await runSweepCycle(dbThatThrows('ECONNRESET'), redis, NOW, key);
  assert.equal(failed.outcome, 'failed');
  const recovered = await runSweepCycle(idleDb(), redis, new Date(NOW.getTime() + 1_000), key);
  assert.equal(recovered.outcome, 'ran', 'the next cycle must run cleanly once the underlying failure clears');
});

test('7) an expired lock from a crashed prior cycle does not block the next cycle', async () => {
  const key = uniqueKey();
  const crashed = await acquireSweepLock(redis, 150, undefined, key); // simulates a process that died holding the lock
  assert.ok(crashed);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const result = await runSweepCycle(idleDb(), redis, NOW, key);
  assert.equal(result.outcome, 'ran', 'TTL expiry must let a fresh cycle proceed without manual intervention');
});

test.after(async () => {
  await redis.quit();
});
