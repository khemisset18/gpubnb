import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { jobLeaseExpiresAt } from '../src/job-execution-lease.js';

test('a 90 second job lease leaves explicit margin for a 30 second network outage', () => {
  const claimedAt = new Date('2026-09-07T00:00:00.000Z');
  const leaseExpiresAt = jobLeaseExpiresAt(claimedAt, 90);
  const networkRecoveredAt = new Date(claimedAt.getTime() + 30_000);

  assert.equal(leaseExpiresAt.getTime() - claimedAt.getTime(), 90_000);
  assert.ok(networkRecoveredAt < leaseExpiresAt);
  assert.equal(leaseExpiresAt.getTime() - networkRecoveredAt.getTime(), 60_000);
});

test('API defaults, example environment and agent refresh loop preserve the same lease safety budget', async () => {
  const config = await readFile(new URL('../src/config.ts', import.meta.url), 'utf8');
  const envExample = await readFile(new URL('../../../.env.example', import.meta.url), 'utf8');
  const agentCli = await readFile(new URL('../../../agent/gpubnb_agent/cli.py', import.meta.url), 'utf8');

  assert.match(config, /JOB_RECLAIM_AFTER_SECONDS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(30\)\.max\(300\)\.default\(90\)/);
  assert.match(envExample, /^JOB_RECLAIM_AFTER_SECONDS=90$/m);
  assert.doesNotMatch(envExample, /^JOB_RECLAIM_AFTER_SECONDS=45$/m);
  assert.match(agentCli, /lease_stop\.wait\(10\)/);
  assert.match(agentCli, /timeout=6\)/);
});
