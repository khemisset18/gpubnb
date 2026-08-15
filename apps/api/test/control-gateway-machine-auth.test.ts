import test from 'node:test';
import assert from 'node:assert/strict';
import type { Redis } from 'ioredis';

import {
  machineAuthCacheKey,
  revokeMachineAuthCache,
  syncMachineAuthCache,
} from '../src/machine-auth-cache.js';

test('machine auth cache is Redis Cluster-safe and contains only gateway auth material', async () => {
  const calls: unknown[][] = [];
  const redis = {
    hset: async (...args: unknown[]) => {
      calls.push(args);
      return 1;
    },
  } as unknown as Redis;

  await syncMachineAuthCache(redis, {
    machineId: 'machine_00000001',
    agentPublicKey: '11111111111111111111111111111111',
    keyVersion: 1,
    nowMs: 1234,
  });

  assert.equal(machineAuthCacheKey('machine_00000001'), 'gpubnb:machine-auth:{machine_00000001}:v1');
  assert.deepEqual(calls[0], [
    'gpubnb:machine-auth:{machine_00000001}:v1',
    'agentPublicKey', '11111111111111111111111111111111',
    'keyVersion', '1',
    'status', 'ACTIVE',
    'updatedAtMs', '1234',
  ]);
  assert.equal(JSON.stringify(calls).includes('ownerId'), false);
  assert.equal(JSON.stringify(calls).includes('email'), false);
});

test('revocation fails closed without deleting the audit-visible cache record', async () => {
  const calls: unknown[][] = [];
  const redis = {
    hset: async (...args: unknown[]) => {
      calls.push(args);
      return 1;
    },
  } as unknown as Redis;

  await revokeMachineAuthCache(redis, 'machine_00000001', 5678);
  assert.deepEqual(calls[0], [
    'gpubnb:machine-auth:{machine_00000001}:v1',
    'status', 'REVOKED',
    'updatedAtMs', '5678',
  ]);
});

test('unsafe identifiers and non-base58 public keys are rejected before Redis', async () => {
  const redis = { hset: async () => 1 } as unknown as Redis;
  await assert.rejects(
    syncMachineAuthCache(redis, {
      machineId: '../../etc/passwd',
      agentPublicKey: '11111111111111111111111111111111',
    }),
  );
  await assert.rejects(
    syncMachineAuthCache(redis, {
      machineId: 'machine_00000001',
      agentPublicKey: '00000000000000000000000000000000',
    }),
  );
});
