import test from 'node:test'; import assert from 'node:assert/strict'; import { z } from 'zod';

const heartbeatSchema = z.object({
  machineId: z.string().cuid(), counter: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  challenge: z.string().min(16).max(200), timestamp: z.string().datetime(),
  gpuUuid: z.string().min(5).max(200), gpuModel: z.string().min(2).max(200),
  vramMiB: z.number().int().positive().max(1_000_000), driverVersion: z.string().max(100),
  cudaVersion: z.string().max(50).nullable().optional(), gpuVendor: z.string().max(20).nullable().optional(),
  gpuUtilization: z.number().int().min(0).max(100), memoryUsedMiB: z.number().int().min(0),
  temperatureC: z.number().int().min(-20).max(130), powerWatts: z.number().min(0).max(5000).nullable().optional(),
  cudaProbeOk: z.boolean(), sessionId: z.string().cuid().nullable(), signature: z.string().max(200),
  agentVersion: z.string().max(40).optional(), hardwareChanged: z.boolean().optional(),
});

const inventorySchema = z.object({
  agentVersion: z.string().trim().min(1).max(40),
  system: z.object({
    os: z.string().max(80), osVersion: z.string().max(300), cpu: z.string().max(300),
    cpuCount: z.number().int().min(1).max(1024).nullable().optional(),
    ramTotalMiB: z.number().int().min(1).max(100_000_000).nullable().optional(),
    diskTotalMiB: z.number().int().min(1).max(1_000_000_000), dockerAvailable: z.boolean(),
    nvidiaRuntimeAvailable: z.boolean().optional(), virtualizationAvailable: z.boolean().optional(),
  }),
  gpus: z.array(z.object({
    gpuModel: z.string().max(200), gpuUuid: z.string().max(200), vramMiB: z.number().int().positive().max(1_000_000),
    driverVersion: z.string().max(100), cudaVersion: z.string().max(50).nullable().optional(),
    gpuVendor: z.string().max(20).nullable().optional(),
  })).max(16),
});

test('heartbeat accepts NVIDIA with cudaVersion', () => {
  const r = heartbeatSchema.safeParse({
    machineId: 'ck0000000000000000000000', counter: 1, challenge: 'a'.repeat(20),
    timestamp: '2025-01-01T00:00:00.000Z', gpuUuid: 'GPU-12345', gpuModel: 'RTX 4090',
    vramMiB: 24576, driverVersion: '550.0', cudaVersion: '12.4', gpuVendor: 'NVIDIA',
    gpuUtilization: 5, memoryUsedMiB: 500, temperatureC: 45, cudaProbeOk: true,
    sessionId: null, signature: 'x'.repeat(64),
  });
  assert.ok(r.success);
});

test('heartbeat accepts AMD without cudaVersion', () => {
  const r = heartbeatSchema.safeParse({
    machineId: 'ck0000000000000000000000', counter: 2, challenge: 'b'.repeat(20),
    timestamp: '2025-01-01T00:00:01.000Z', gpuUuid: 'AMD-67890', gpuModel: 'RX 7900 XTX',
    vramMiB: 24576, driverVersion: 'rocm-6.0', gpuVendor: 'AMD',
    gpuUtilization: 3, memoryUsedMiB: 300, temperatureC: 50, cudaProbeOk: true,
    sessionId: null, signature: 'y'.repeat(64), hardwareChanged: false,
  });
  assert.ok(r.success);
});

test('heartbeat accepts Intel with gpuVendor INTEL', () => {
  const r = heartbeatSchema.safeParse({
    machineId: 'ck0000000000000000000000', counter: 3, challenge: 'c'.repeat(20),
    timestamp: '2025-01-01T00:00:02.000Z', gpuUuid: 'intel-0x0bd5', gpuModel: 'Arc A770',
    vramMiB: 16384, driverVersion: 'xpu-1.0', gpuVendor: 'INTEL',
    gpuUtilization: 0, memoryUsedMiB: 0, temperatureC: 35, cudaProbeOk: true,
    sessionId: null, signature: 'z'.repeat(64),
  });
  assert.ok(r.success);
});

test('inventory accepts without nvidiaRuntimeAvailable', () => {
  const r = inventorySchema.safeParse({
    agentVersion: '0.5.0',
    system: { os: 'Linux', osVersion: '6.6', cpu: 'AMD Ryzen', cpuCount: 8, ramTotalMiB: 32768, diskTotalMiB: 500000, dockerAvailable: true },
    gpus: [{ gpuModel: 'RX 7900 XTX', gpuUuid: 'AMD-1', vramMiB: 24576, driverVersion: 'rocm-6.0', gpuVendor: 'AMD' }],
  });
  assert.ok(r.success);
});

test('inventory accepts with nvidiaRuntimeAvailable false', () => {
  const r = inventorySchema.safeParse({
    agentVersion: '0.5.0',
    system: { os: 'Windows', osVersion: '10.0', cpu: 'Intel i9', cpuCount: 16, ramTotalMiB: 65536, diskTotalMiB: 1000000, dockerAvailable: true, nvidiaRuntimeAvailable: false },
    gpus: [{ gpuModel: 'Arc A770', gpuUuid: 'intel-1', vramMiB: 16384, driverVersion: 'xpu-1.0', gpuVendor: 'INTEL' }],
  });
  assert.ok(r.success);
});
