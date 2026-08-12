import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildOfflineSweepPlan, heartbeatCutoff } from '../src/offline-sweep.js';

test('builds a deterministic idempotent offline transition plan', () => {
  const plan = buildOfflineSweepPlan({
    machineIds: ['m2', 'm1', 'm2'],
    activeBookingIds: ['b1', 'b1'],
    activeWorkspaceSessionIds: ['s2', 's1'],
    activeJobIds: ['j1', 'j1'],
  });

  assert.deepEqual(plan, {
    machineIds: ['m1', 'm2'],
    listingMachineIds: ['m1', 'm2'],
    degradedBookingIds: ['b1'],
    failedWorkspaceSessionIds: ['s1', 's2'],
    cancelledJobIds: ['j1'],
    stopValidatedUsage: true,
  });
});

test('computes the heartbeat cutoff from a trusted server clock', () => {
  const now = new Date('2026-07-24T12:00:00.000Z');
  assert.equal(heartbeatCutoff(now, 40).toISOString(), '2026-07-24T11:59:20.000Z');
});

test('rejects invalid offline thresholds', () => {
  assert.throws(() => heartbeatCutoff(new Date(), 0), RangeError);
  assert.throws(() => heartbeatCutoff(new Date(), 1.5), RangeError);
});

test('offline cancellation closes the explicit lease and unfinished attempt atomically', async () => {
  const source = await readFile(new URL('../src/offline-sweep-service.ts', import.meta.url), 'utf8');
  const normalized = source.replace(/\s+/g, '');

  assert.match(normalized, /status:JobStatus\.CANCELLED,errorCode:'AGENT_OFFLINE',cancelRequestedAt:now,finishedAt:now,leaseExpiresAt:null/);
  assert.match(normalized, /if\(jobUpdate\.count>0\)\{awaittx\.jobAttempt\.updateMany/);
  assert.match(normalized, /jobId:\{in:plan\.cancelledJobIds\},finishedAt:null,job:\{status:JobStatus\.CANCELLED,errorCode:'AGENT_OFFLINE'\}/);
  assert.match(normalized, /data:\{finishedAt:now,failureReason:'AGENT_OFFLINE',?\}/);
  assert.match(normalized, /isolationLevel:'Serializable'/);
});

test('offline sweep never turns an offline machine back to available or claims financial success', async () => {
  const source = await readFile(new URL('../src/offline-sweep-service.ts', import.meta.url), 'utf8');
  const normalized = source.replace(/\s+/g, '');

  assert.match(normalized, /connectivity:MachineConnectivity\.OFFLINE,operational:MachineOperational\.UNAVAILABLE/);
  assert.match(normalized, /status:PaymentStatus\.SETTLEMENT_PENDING/);
  assert.doesNotMatch(normalized, /MachineOperational\.AVAILABLE/);
  assert.doesNotMatch(normalized, /PaymentStatus\.(?:RELEASED|PAID|COMPLETED)/);
});
