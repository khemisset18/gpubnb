import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeMiningResourceTelemetry,
  syncMiningResourceTelemetry,
} from '../src/mining-resource-telemetry.js';

const valid = {
  resourceId: '3f778f43-21a6-4be5-a432-2f5e14cf9c01',
  hardwareUuid: 'GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a',
  state: 'MINING' as const,
  maximumTemperatureC: 94,
  temperatureC: 70.5,
  powerWatts: 82.25,
  utilizationPercent: 91,
  hashrate: 42.5,
  hashrateUnit: 'MH/s' as const,
  acceptedShares: 5,
  staleShares: 1,
  hardwareErrors: 0,
  uptimeSeconds: 600,
  poolConnected: true,
  sampledAtMs: 1_700_000_000_000,
  lastStopReason: null,
};

test('mining telemetry accepts only the explicit privacy-preserving shape', () => {
  assert.deepEqual(sanitizeMiningResourceTelemetry([valid]), [valid]);

  for (const sensitive of [
    { pid: 4242 },
    { executablePath: 'C:/secret/miner.exe' },
    { logPath: 'C:/secret/miner.log' },
    { poolUrl: 'stratum+tcp://secret.example:4444' },
    { walletAddress: 'secret-wallet' },
    { workerName: 'secret-worker' },
    { commandId: 'secret-command' },
  ]) {
    assert.throws(() => sanitizeMiningResourceTelemetry([{ ...valid, ...sensitive }]));
  }
});

test('mining telemetry rejects impossible values and unbounded batches', () => {
  assert.throws(() => sanitizeMiningResourceTelemetry([{ ...valid, state: 'STARTING' }]));
  assert.throws(() => sanitizeMiningResourceTelemetry([{ ...valid, maximumTemperatureC: 99 }]));
  assert.throws(() => sanitizeMiningResourceTelemetry([{ ...valid, temperatureC: 151 }]));
  assert.throws(() => sanitizeMiningResourceTelemetry(Array.from({ length: 33 }, () => valid)));
});

test('sync updates only through exact machine resource and hardware identity predicates', async () => {
  const calls: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
  let call = 0;
  const fake = {
    $executeRaw: async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
      calls.push(query);
      call += 1;
      return call === 1 ? 1 : 0;
    },
  };

  const second = {
    ...valid,
    resourceId: '7b0a9942-b31d-4be7-b16d-50afff834a68',
    hardwareUuid: 'GPU-bbbbbbbb-2a14-2b3f-f057-b21f3b00524a',
    state: 'STOPPED' as const,
  };
  const receivedAt = new Date('2026-09-24T05:30:00.000Z');
  const result = await syncMiningResourceTelemetry(
    fake as never,
    'machine_00000001',
    [valid, second],
    receivedAt,
  );

  assert.deepEqual(result, { accepted: 1, ignored: 1 });
  assert.equal(calls.length, 2);
  const sql = calls[0].strings.join(' ');
  assert.match(sql, /r\."id"/);
  assert.match(sql, /a\."hardwareUuid"/);
  assert.match(sql, /r\."machineId"/);
  assert.ok(calls[0].values.includes(valid.resourceId));
  assert.ok(calls[0].values.includes(valid.hardwareUuid));
  assert.ok(calls[0].values.includes('machine_00000001'));

  const serialized = String(calls[0].values.find((value) =>
    typeof value === 'string' && value.includes('"resourceId"'),
  ));
  assert.doesNotMatch(serialized, /pid|executable|logPath|poolUrl|walletAddress|workerName|commandId/i);
});
