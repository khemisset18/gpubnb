import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WINDOWS_NATIVE_GPU_UUID_RE,
  validateWindowsNativeCapability,
} from '../src/windows-native-capability.js';

const GPU_UUID = 'GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a';

function accelerator(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    provider: 'gpu',
    kind: 'GPU',
    vendor: 'NVIDIA',
    model: 'GeForce',
    deviceId: GPU_UUID,
    memoryTotalMiB: 8192,
    memoryUsedMiB: 0,
    utilizationPercent: 0,
    temperatureC: 40,
    powerWatts: 20,
    available: true,
    throttling: false,
    capabilities: {},
    metrics: {},
    ...overrides,
  };
}

test('canonical Windows native GPU UUID pattern accepts only physical NVIDIA UUID shape', () => {
  assert.equal(WINDOWS_NATIVE_GPU_UUID_RE.test(GPU_UUID), true);
  assert.equal(WINDOWS_NATIVE_GPU_UUID_RE.test('GPU-EXACT'), false);
  assert.equal(WINDOWS_NATIVE_GPU_UUID_RE.test('MIG-e8301c16-2a14-2b3f-f057-b21f3b00524a'), false);
});

test('unavailable native capability is valid only without a GPU UUID', () => {
  assert.deepEqual(
    validateWindowsNativeCapability({
      operatingSystem: 'Windows',
      available: false,
      gpuUuid: null,
      rawAccelerators: [],
    }),
    { ok: true, available: false, gpuUuid: null },
  );
  assert.deepEqual(
    validateWindowsNativeCapability({
      operatingSystem: 'Windows',
      available: false,
      gpuUuid: GPU_UUID,
      rawAccelerators: [accelerator()],
    }),
    { ok: false },
  );
});

test('positive native capability requires Windows and exact available NVIDIA GPU in same inventory', () => {
  const base = {
    operatingSystem: 'Windows 11',
    available: true,
    gpuUuid: GPU_UUID,
  };

  assert.deepEqual(
    validateWindowsNativeCapability({ ...base, rawAccelerators: [accelerator()] }),
    { ok: true, available: true, gpuUuid: GPU_UUID },
  );
  assert.deepEqual(
    validateWindowsNativeCapability({
      ...base,
      operatingSystem: 'Linux',
      rawAccelerators: [accelerator()],
    }),
    { ok: false },
  );
  assert.deepEqual(
    validateWindowsNativeCapability({
      ...base,
      rawAccelerators: [accelerator({ vendor: 'AMD' })],
    }),
    { ok: false },
  );
  assert.deepEqual(
    validateWindowsNativeCapability({
      ...base,
      rawAccelerators: [accelerator({ available: false })],
    }),
    { ok: false },
  );
  assert.deepEqual(
    validateWindowsNativeCapability({
      ...base,
      rawAccelerators: [accelerator({ deviceId: 'GPU-11111111-1111-1111-1111-111111111111' })],
    }),
    { ok: false },
  );
});

test('positive native capability rejects malformed UUID before inventory can authorize it', () => {
  assert.deepEqual(
    validateWindowsNativeCapability({
      operatingSystem: 'Windows',
      available: true,
      gpuUuid: 'GPU-EXACT',
      rawAccelerators: [accelerator()],
    }),
    { ok: false },
  );
});
