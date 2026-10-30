import assert from 'node:assert/strict';
import test from 'node:test';
import type { Redis } from 'ioredis';

import {
  CONSOLE_PROOF_TTL_SECONDS,
  qualificationNativeSource,
  readConsoleProof,
  replaceConsoleProof,
  verifiedConsoleProof,
  type SignedConsoleProof,
} from '../src/windows-native-private-console-proof.js';

const GPU = 'GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a';
const SHA = 'f664a07ec500c57bf9a508838f51b7c0305ba92d';
const NOW = Date.parse('2026-10-30T21:10:00Z');
const acceleration = [{
  schemaVersion: 1, provider: 'gpu', kind: 'GPU', vendor: 'NVIDIA',
  model: 'GeForce GTX 1650', deviceId: GPU, memoryTotalMiB: 4096,
  memoryUsedMiB: 0, utilizationPercent: 0, temperatureC: 40, powerWatts: 25,
  available: true, throttling: false, capabilities: {}, metrics: {},
}];
const positive: SignedConsoleProof = {
  schemaVersion: 1,
  captureBackend: 'console-dedicated',
  available: true,
  gpuUuid: GPU,
  agentCommit: SHA,
  helperVersion: 'v0.1',
  hardwareEncoder: 'nvenc',
  measuredAt: new Date(NOW).toISOString(),
};
const context = {
  approvedCommit: SHA, operatingSystem: 'Windows 11', primaryGpuUuid: GPU,
  accelerators: acceleration, nowMs: NOW,
};

test('signed physical console report accepts only exact GPU, NVENC, version, timing and OS', () => {
  assert.deepEqual(verifiedConsoleProof(positive, context), { gpuUuid: GPU, agentCommit: SHA });
  assert.equal(verifiedConsoleProof(positive, { ...context, approvedCommit: null }), null);
  assert.equal(verifiedConsoleProof(positive, { ...context, operatingSystem: 'Linux' }), null);
  assert.equal(verifiedConsoleProof(positive, { ...context, primaryGpuUuid: 'GPU-11111111-1111-1111-1111-111111111111' }), null);
  assert.equal(verifiedConsoleProof(positive, { ...context, accelerators: [{ ...acceleration[0], vendor: 'AMD' }] }), null);
  assert.equal(verifiedConsoleProof(positive, { ...context, accelerators: [{ ...acceleration[0], available: false }] }), null);
  assert.equal(verifiedConsoleProof({ ...positive, available: false }, context), null);
  assert.equal(verifiedConsoleProof({ ...positive, gpuUuid: null }, context), null);
  assert.equal(verifiedConsoleProof({ ...positive, agentCommit: 'a'.repeat(40) }, context), null);
  assert.equal(verifiedConsoleProof({ ...positive, hardwareEncoder: null }, context), null);
  assert.equal(verifiedConsoleProof({ ...positive, helperVersion: null }, context), null);
  assert.equal(verifiedConsoleProof({ ...positive, measuredAt: new Date(NOW - 60_001).toISOString() }, context), null);
  assert.equal(verifiedConsoleProof({ ...positive, measuredAt: new Date(NOW + 5_001).toISOString() }, context), null);
});

test('console claim is bounded in Redis and revoked by negative heartbeat', async () => {
  const keys = new Map<string, string>();
  const storage = {
    set: async (key: string, value: string, command: string, ttl: number) => {
      assert.equal(command, 'EX');
      assert.equal(ttl, CONSOLE_PROOF_TTL_SECONDS);
      keys.set(key, value);
    },
    get: async (key: string) => keys.get(key) ?? null,
    del: async (key: string) => { keys.delete(key); },
  } as unknown as Redis;
  await replaceConsoleProof(storage, 'machine-test', { gpuUuid: GPU, agentCommit: SHA }, '21');
  assert.deepEqual(await readConsoleProof(storage, 'machine-test', SHA, '21'), { gpuUuid: GPU, agentCommit: SHA });
  assert.equal(await readConsoleProof(storage, 'machine-test', 'a'.repeat(40), '21'), null);
  assert.equal(await readConsoleProof(storage, 'machine-test', SHA, '22'), null, 'stale heartbeat counter must not authorize console');
  assert.deepEqual(await qualificationNativeSource(storage, 'machine-test', SHA, false, null, BigInt(21)), {
    gpuUuid: GPU, captureBackend: 'console-dedicated',
  });
  await replaceConsoleProof(storage, 'machine-test', null, '22');
  assert.equal(await readConsoleProof(storage, 'machine-test', SHA, '21'), null);
  assert.equal(await qualificationNativeSource(storage, 'machine-test', SHA, false, null, BigInt(21)), null);
  assert.deepEqual(await qualificationNativeSource(storage, 'machine-test', null, true, GPU, BigInt(22)), {
    gpuUuid: GPU, captureBackend: 'iddcx',
  });
});
