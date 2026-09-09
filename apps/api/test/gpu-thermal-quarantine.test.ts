import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GPU_THERMAL_QUARANTINE_CELSIUS,
  GPU_THERMAL_RECOVERY_CELSIUS,
  GPU_THERMAL_SUBREASON,
  enforceGpuThermalQuarantine,
  hottestGpuTemperature,
} from '../src/gpu-thermal-quarantine.js';
import type { AcceleratorTelemetry } from '../src/accelerator-telemetry.js';

function gpu(temperatureC: number, deviceId = 'GPU-aaaaaaaa'): AcceleratorTelemetry {
  return {
    schemaVersion: 1,
    kind: 'GPU',
    vendor: 'NVIDIA',
    model: 'Test GPU',
    deviceId,
    busAddress: null,
    driverVersion: '592.82',
    runtimeVersion: '13.1',
    memoryTotalMiB: 4096,
    memoryUsedMiB: 0,
    utilizationPercent: 0,
    temperatureC,
    powerWatts: 6,
    available: true,
    throttling: false,
    capabilities: {},
    metrics: {},
  };
}

function fakeTx(options: {
  moderationStatus?: 'CLEAR' | 'QUARANTINED';
  activeThermal?: boolean;
  latestTemperature?: number;
} = {}) {
  const events: Array<Record<string, unknown>> = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  let moderationStatus = options.moderationStatus ?? 'CLEAR';
  let activeThermal = options.activeThermal ?? false;
  const tx = {
    machineQuarantineEvent: {
      findFirst: async () => activeThermal ? { id: 'thermal-event', createdAt: new Date() } : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        if (data.source === 'accelerator-heartbeat.thermal') activeThermal = true;
        return data;
      },
    },
    machine: {
      findUnique: async () => ({ moderationStatus, quarantineReasonCode: 'GPU_HEALTH_CHECK_FAILED' }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.moderationStatus === 'QUARANTINED') moderationStatus = 'QUARANTINED';
        return { id: 'machine' };
      },
    },
    accelerator: {
      updateMany: async () => ({ count: 1 }),
    },
    gpuListing: {
      updateMany: async () => ({ count: 1 }),
    },
    diagnosticRun: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'diag-auto-1', ...data };
        diagnostics.push(row);
        return { id: 'diag-auto-1' };
      },
    },
    heartbeat: {
      findFirst: async () => options.latestTemperature == null ? null : {
        temperatureC: options.latestTemperature,
        receivedAt: new Date(),
      },
    },
  };
  return { tx: tx as never, events, diagnostics, getModeration: () => moderationStatus };
}

test('thermal quarantine boundary is exactly 98 C, never below', async () => {
  assert.equal(GPU_THERMAL_QUARANTINE_CELSIUS, 98);
  const below = fakeTx();
  const result = await enforceGpuThermalQuarantine(below.tx, 'machine_00000001', [gpu(97.999)]);
  assert.equal(result.quarantineEntered, false);
  assert.equal(result.blocking, false);
  assert.equal(below.events.length, 0);
  assert.equal(below.getModeration(), 'CLEAR');
});

test('98 C enters quarantine with an explicit measured thermal cause', async () => {
  const state = fakeTx();
  const result = await enforceGpuThermalQuarantine(state.tx, 'machine_00000001', [gpu(98)]);
  assert.equal(result.quarantineEntered, true);
  assert.equal(result.blocking, true);
  assert.equal(state.getModeration(), 'QUARANTINED');
  const entered = state.events.find((event) => event.source === 'accelerator-heartbeat.thermal');
  assert.ok(entered);
  assert.match(String(entered.reason), /98/);
  assert.equal((entered.details as Record<string, unknown>).subreasonCode, GPU_THERMAL_SUBREASON);
  assert.equal((entered.details as Record<string, unknown>).quarantineThresholdC, 98);
});

test('hottest physical GPU is the one that owns the thermal decision', () => {
  const hottest = hottestGpuTemperature([gpu(82, 'GPU-aaaaaaaa'), gpu(98.5, 'GPU-bbbbbbbb')]);
  assert.deepEqual(hottest, { hardwareUuid: 'GPU-bbbbbbbb', temperatureC: 98.5 });
});

test('an existing unrelated quarantine is never overwritten by temperature', async () => {
  const state = fakeTx({ moderationStatus: 'QUARANTINED', activeThermal: false });
  const result = await enforceGpuThermalQuarantine(state.tx, 'machine_00000001', [gpu(101)]);
  assert.equal(result.quarantineEntered, false);
  assert.equal(result.blocking, true);
  assert.equal(state.events.length, 0);
});

test('thermal quarantine auto-queues a real diagnostic after cooldown', async () => {
  assert.equal(GPU_THERMAL_RECOVERY_CELSIUS, 90);
  const state = fakeTx({ moderationStatus: 'QUARANTINED', activeThermal: true });
  const result = await enforceGpuThermalQuarantine(state.tx, 'machine_00000001', [gpu(89)]);
  assert.equal(result.blocking, true, 'heartbeat never clears quarantine directly');
  assert.equal(result.recoveryDiagnosticRunId, 'diag-auto-1');
  assert.equal(state.diagnostics.length, 1);
  const event = state.events.find((item) => item.source === 'accelerator-heartbeat.thermal-recovery');
  assert.ok(event);
  assert.match(String(event.reason), /diagnostic automatique/i);
});

test('cooldown above recovery threshold does not auto-start a diagnostic', async () => {
  const state = fakeTx({ moderationStatus: 'QUARANTINED', activeThermal: true });
  const result = await enforceGpuThermalQuarantine(state.tx, 'machine_00000001', [gpu(91)]);
  assert.equal(result.recoveryDiagnosticRunId, null);
  assert.equal(state.diagnostics.length, 0);
});
