import assert from 'node:assert/strict';
import test from 'node:test';

import { syncMiningHeartbeatTelemetry } from '../src/mining-heartbeat-telemetry.js';

test('mining heartbeat telemetry is scoped by machine, resource and hardware UUID', async () => {
  const calls: unknown[] = [];
  const tx = {
    $queryRaw: async (query: any) => {
      calls.push(query);
      return [{ id: 'resource_00000001' }];
    },
  };
  const updated = await syncMiningHeartbeatTelemetry(tx as any, 'machine_00000001', [{
    resourceId: 'resource_00000001',
    hardwareUuid: 'GPU-aaaaaaaa',
    state: 'MINING',
    temperatureC: 70,
    powerWatts: 80,
    utilizationPercent: 90,
    hashrate: 42.5,
    hashrateUnit: 'MH/s',
    acceptedShares: 3,
    staleShares: 1,
    hardwareErrors: 0,
    uptimeSeconds: 60,
    poolConnected: true,
    sampledAtMs: 123456,
  }]);

  assert.deepEqual(updated, ['resource_00000001']);
  assert.equal(calls.length, 1);
  const query: any = calls[0];
  const sql = Array.isArray(query.strings) ? query.strings.join('?') : String(query);
  assert.match(sql, /r\."machineId"/);
  assert.match(sql, /r\."id"/);
  assert.match(sql, /a\."hardwareUuid"/);
  assert.doesNotMatch(sql, /"runtimeState"\s*=/);
  assert.ok(query.values.includes('machine_00000001'));
  assert.ok(query.values.includes('resource_00000001'));
  assert.ok(query.values.includes('GPU-aaaaaaaa'));
  const serialized = JSON.stringify(query.values);
  assert.doesNotMatch(serialized, /wallet|poolUrl|logPath|executablePath|commandId/i);
});

test('mining heartbeat telemetry is capped at 64 resource updates', async () => {
  let calls = 0;
  const tx = {
    $queryRaw: async () => { calls += 1; return []; },
  };
  const snapshots = Array.from({ length: 70 }, (_, index) => ({
    resourceId: `resource_${index.toString().padStart(8, '0')}`,
    hardwareUuid: `GPU-${index.toString().padStart(8, '0')}`,
    state: 'STOPPED' as const,
    temperatureC: null,
    powerWatts: null,
    utilizationPercent: null,
    hashrate: null,
    hashrateUnit: null,
    acceptedShares: null,
    staleShares: null,
    hardwareErrors: null,
    uptimeSeconds: null,
    poolConnected: false,
    sampledAtMs: null,
  }));
  await syncMiningHeartbeatTelemetry(tx as any, 'machine_00000001', snapshots);
  assert.equal(calls, 64);
});

test('heartbeat wiring accepts bounded mining observations without creating a lifecycle authority', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../src/server.ts', import.meta.url), 'utf8')
  );
  assert.match(source, /miningResources:z\.array\(/);
  assert.match(source, /\.max\(64\)\.optional\(\)/);
  assert.match(source, /syncMiningHeartbeatTelemetry\(tx,m\.id,b\.telemetry\.miningResources\)/);
  assert.doesNotMatch(
    source,
    /syncMiningHeartbeatTelemetry[\s\S]{0,500}runtimeState/,
    'heartbeat telemetry must not become mining lifecycle authority',
  );
});
