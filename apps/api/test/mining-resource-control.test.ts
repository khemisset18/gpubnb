import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFencedStartMining, buildFencedStopMining } from '../src/mining-resource-control.js';
import type { ResourceLeaseSnapshot } from '../src/resource-lease.js';

const lease = (resourceId = 'resource_00000001'): ResourceLeaseSnapshot => ({
  protocolVersion: 1,
  resourceId,
  holderId: 'holder_00000001',
  idempotencyKey: 'mining_start_00000001',
  leaseId: 'lease_00000001',
  fencingToken: '9223372036854775807',
  ttlMs: 45_000,
});

test('start payload binds hardware and preserves i64 fence as exact string', () => {
  const command = buildFencedStartMining({
    machineId: 'machine_00000001',
    resourceId: 'resource_00000001',
    hardwareUuid: 'GPU-aaaaaaaa',
    profileId: 'lolminer_etchash',
    poolUrl: 'stratum+tcp://pool.example.com:4444',
    walletAddress: 'wallet.example-123',
    workerName: 'worker_1',
    performanceMode: 'FULL',
  }, lease());

  assert.equal(command.lease.fencingToken, '9223372036854775807');
  assert.equal(command.payload.runtimeGeneration, '9223372036854775807');
  assert.equal(typeof command.payload.runtimeGeneration, 'string');
  assert.equal(command.payload.resourceId, command.lease.resourceId);
  assert.equal(command.payload.hardwareUuid, 'GPU-aaaaaaaa');
});

test('stop payload carries only resource identity and exact generation', () => {
  const command = buildFencedStopMining({
    machineId: 'machine_00000001',
    resourceId: 'resource_00000001',
    hardwareUuid: 'GPU-aaaaaaaa',
  }, lease());
  assert.deepEqual(command.payload, {
    resourceId: 'resource_00000001',
    hardwareUuid: 'GPU-aaaaaaaa',
    runtimeGeneration: '9223372036854775807',
  });
});

test('lease for another GPU can never be reused', () => {
  assert.throws(() => buildFencedStopMining({
    machineId: 'machine_00000001',
    resourceId: 'resource_00000001',
    hardwareUuid: 'GPU-aaaaaaaa',
  }, lease('resource_00000002')), /mining_resource_lease_mismatch/);
});
