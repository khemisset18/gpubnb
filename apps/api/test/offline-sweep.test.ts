import test from 'node:test';
import assert from 'node:assert/strict';
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
