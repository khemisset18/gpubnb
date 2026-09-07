import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tryTransactionAdvisoryLock } from '../src/transaction-advisory-lock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '../src');

test('transaction advisory helper reports PostgreSQL lock ownership', async () => {
  const acquiredTx = { $queryRaw: async () => [{ acquired: true }] };
  const busyTx = { $queryRaw: async () => [{ acquired: false }] };

  assert.equal(await tryTransactionAdvisoryLock(acquiredTx as never, 'gpubnb:test-sweep'), true);
  assert.equal(await tryTransactionAdvisoryLock(busyTx as never, 'gpubnb:test-sweep'), false);
});

test('transaction advisory helper rejects unbounded task names', async () => {
  const tx = { $queryRaw: async () => [{ acquired: true }] };
  await assert.rejects(
    () => tryTransactionAdvisoryLock(tx as never, '../unsafe name'),
    /invalid_advisory_task_name/,
  );
});

test('destructive periodic sweeps are fenced before reading mutable state', async () => {
  const offline = await readFile(path.join(srcDir, 'offline-sweep-service.ts'), 'utf8');
  const stale = await readFile(path.join(srcDir, 'job-staleness-sweep.ts'), 'utf8');

  const offlineLock = offline.indexOf("tryTransactionAdvisoryLock(tx, 'gpubnb:offline-sweep')");
  const offlineRead = offline.indexOf('tx.machine.findMany');
  assert.ok(offlineLock >= 0 && offlineLock < offlineRead, 'offline sweep must acquire its transaction lock before reading machines');

  const staleLock = stale.indexOf("tryTransactionAdvisoryLock(tx, 'gpubnb:stale-job-sweep')");
  const staleRead = stale.indexOf('tx.job.findMany');
  assert.ok(staleLock >= 0 && staleLock < staleRead, 'stale-job sweep must acquire its transaction lock before reading jobs');
});
