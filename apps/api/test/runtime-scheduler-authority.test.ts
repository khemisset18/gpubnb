import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const serverUrl = new URL('../src/server.ts', import.meta.url);
const workerUrl = new URL('../src/delivery-worker.ts', import.meta.url);

test('API reconciliation tick is protected by a distributed lease', async () => {
  const source = await readFile(serverUrl, 'utf8');
  const start = source.indexOf('const reconcileIntervalId=setInterval');
  assert.ok(start >= 0, 'reconciliation interval must exist');
  const end = source.indexOf('\n', start);
  const line = source.slice(start, end < 0 ? source.length : end);
  assert.match(line, /runWithDistributedTaskLease\(redis,'api-reconciliation-tick'/);
  assert.match(line, /reconcileDevelopmentBookingsScheduled\(redis,db,now\)/);
  assert.doesNotMatch(line, /reconcileDevelopmentBookings\(db,now\)/);
});

test('API offline and stale-job sweep is protected by a distributed lease', async () => {
  const source = await readFile(serverUrl, 'utf8');
  const start = source.indexOf('const sweepIntervalId=setInterval');
  assert.ok(start >= 0, 'sweep interval must exist');
  const end = source.indexOf('\n', start);
  const line = source.slice(start, end < 0 ? source.length : end);
  assert.match(line, /runWithDistributedTaskLease\(redis,'api-sweep-tick'/);
  assert.match(line, /sweepOfflineMachines\(db,new Date\(\),config\.HEARTBEAT_OFFLINE_SECONDS\)/);
  assert.match(line, /sweepStaleJobs\(db,new Date\(\),config\.JOB_STALE_AFTER_SECONDS\)/);
});

test('delivery worker uses the same development-bookings scheduler authority', async () => {
  const source = await readFile(workerUrl, 'utf8');
  assert.match(source, /reconcileDevelopmentBookingsScheduled\(redis, db, new Date\(now\)\)/);
  assert.doesNotMatch(source, /reconcileDevelopmentBookings\(db, new Date\(now\)\)/);
});

test('distributed lease helper uses ownership-checked renewal and release', async () => {
  const source = await readFile(new URL('../src/distributed-task-lease.ts', import.meta.url), 'utf8');
  assert.match(source, /redis\.call\('GET', KEYS\[1\]\) == ARGV\[1\]/);
  assert.match(source, /redis\.call\('PEXPIRE'/);
  assert.match(source, /redis\.call\('DEL'/);
  assert.match(source, /'PX', ttlMs, 'NX'/);
  assert.match(source, /leaseValidUntil/);
});

test('provider-specific single-process assumption is gone from runtime scheduler comments', async () => {
  const source = await readFile(serverUrl, 'utf8');
  assert.doesNotMatch(source, /Render's free plan does not support the Background Worker/);
  assert.doesNotMatch(source, /single process, so no distributed lock/);
});
