import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  miningTelemetryEnvelopeSchema,
  miningTelemetrySchema,
  validateMiningTelemetryAuthority,
} from '../src/mining-telemetry-contract.js';

const telemetry = {
  resourceId: 'resource_00000001',
  hardwareUuid: 'GPU-aaaaaaaa',
  runtimeGeneration: '9007199254740993',
  profileId: 'lolminer_etchash',
  processPid: 4242,
  temperatureC: 91,
  powerWatts: 44.5,
  gpuUtilizationPercent: 97,
  memoryUsedMiB: 2048,
  deviceName: 'GTX 1650',
  thermalStopCelsius: 92,
  hashrate: 80.5,
  hashrateUnit: 'MH/s',
  acceptedShares: 4,
  staleShares: 0,
  hardwareErrors: 0,
  uptimeSeconds: 65,
  poolConnected: true,
};

describe('mining telemetry contract', () => {
  it('preserves large runtime generations as decimal strings', () => {
    const parsed = miningTelemetrySchema.parse(telemetry);
    assert.equal(parsed.runtimeGeneration, '9007199254740993');
  });

  it('rejects runtime generations and counters outside signed i64 storage', () => {
    assert.equal(
      miningTelemetrySchema.parse({ ...telemetry, runtimeGeneration: '9223372036854775807' }).runtimeGeneration,
      '9223372036854775807',
    );
    assert.throws(() => miningTelemetrySchema.parse({
      ...telemetry,
      runtimeGeneration: '9223372036854775808',
    }));
    assert.throws(() => miningTelemetryEnvelopeSchema.parse({
      machineId: 'ck0000000000000000000000',
      resourceId: telemetry.resourceId,
      idempotencyKey: 'mining-telemetry:resource_00000001:max:1',
      agentCounter: '9223372036854775808',
      capturedAt: '2026-09-24T02:30:00.000Z',
      telemetry,
    }));
  });

  it('accepts owner-selected GPU thermal cutoffs only inside 85-98 C', () => {
    assert.equal(miningTelemetrySchema.parse({ ...telemetry, thermalStopCelsius: 85 }).thermalStopCelsius, 85);
    assert.equal(miningTelemetrySchema.parse({ ...telemetry, thermalStopCelsius: 98 }).thermalStopCelsius, 98);
    assert.throws(() => miningTelemetrySchema.parse({ ...telemetry, thermalStopCelsius: 84 }));
    assert.throws(() => miningTelemetrySchema.parse({ ...telemetry, thermalStopCelsius: 99 }));
  });

  it('rejects raw miner/pool/wallet fields instead of accepting arbitrary telemetry', () => {
    assert.throws(() => miningTelemetrySchema.parse({ ...telemetry, walletAddress: 'secret-ish-value' }));
    assert.throws(() => miningTelemetrySchema.parse({ ...telemetry, poolUrl: 'stratum+tcp://pool.example:4444' }));
    assert.throws(() => miningTelemetrySchema.parse({ ...telemetry, rawLog: 'miner output' }));
  });

  it('requires MINING state and the exact current resource fence', () => {
    assert.doesNotThrow(() => validateMiningTelemetryAuthority(
      'MINING',
      telemetry.runtimeGeneration,
      telemetry.runtimeGeneration,
    ));
    assert.throws(
      () => validateMiningTelemetryAuthority('STARTING', telemetry.runtimeGeneration, telemetry.runtimeGeneration),
      /mining_resource_not_mining/,
    );
    assert.throws(
      () => validateMiningTelemetryAuthority('MINING', null, telemetry.runtimeGeneration),
      /mining_resource_lease_missing/,
    );
    assert.throws(
      () => validateMiningTelemetryAuthority('MINING', '9007199254740994', telemetry.runtimeGeneration),
      /mining_runtime_generation_stale/,
    );
  });

  it('requires the envelope resource to match the signed telemetry resource', () => {
    const base = {
      machineId: 'ck0000000000000000000000',
      resourceId: telemetry.resourceId,
      idempotencyKey: 'mining-telemetry:resource_00000001:1:1',
      agentCounter: '42',
      capturedAt: '2026-09-24T02:30:00.000Z',
      telemetry,
    };
    assert.equal(miningTelemetryEnvelopeSchema.parse(base).agentCounter, 42n);
    assert.throws(() => miningTelemetryEnvelopeSchema.parse({
      ...base,
      resourceId: 'resource_00000002',
    }));
  });
});
