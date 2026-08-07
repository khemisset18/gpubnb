import assert from 'node:assert/strict';
import test from 'node:test';

// device-authorization-routes.ts imports auth.js, which imports config.ts, which parses
// process.env at module-load time. No other test in this suite touches that import chain,
// so fill in the minimum valid values only if they're not already set (e.g. by CI/.env),
// keeping this test self-contained instead of depending on how the runner loads dotenv.
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'x'.repeat(32);
process.env.INTERNAL_SERVICE_TOKEN ??= 'x'.repeat(32);
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';

const { inventorySchema } = await import('../src/device-authorization-routes.js');

function baseGpu(overrides: Partial<{ gpuModel: string; driverVersion: string; cudaVersion: string }> = {}) {
  return {
    agentVersion: '1.0.0',
    system: {
      os: 'Windows', osVersion: '10.0.26200', cpu: 'Test CPU',
      diskTotalMiB: 100_000, dockerAvailable: true,
    },
    gpus: [{
      gpuModel: overrides.gpuModel ?? 'NVIDIA GeForce RTX 4090',
      gpuUuid: 'GPU-00000000-0000-0000-0000-000000000000',
      vramMiB: 24_564,
      driverVersion: overrides.driverVersion ?? '552.44',
      cudaVersion: overrides.cudaVersion ?? '12.5',
    }],
  };
}

test('inventory accepts GPU strings at the exact Accelerator column widths', () => {
  const result = inventorySchema.parse(baseGpu({
    gpuModel: 'X'.repeat(160),
    driverVersion: 'Y'.repeat(80),
    cudaVersion: 'Z'.repeat(40),
  }));
  assert.equal(result.gpus[0]?.gpuModel.length, 160);
});

test('inventory rejects a gpuModel one character past Accelerator.model VarChar(160)', () => {
  assert.throws(() => inventorySchema.parse(baseGpu({ gpuModel: 'X'.repeat(161) })));
});

test('inventory rejects a driverVersion one character past Accelerator.driverVersion VarChar(80)', () => {
  assert.throws(() => inventorySchema.parse(baseGpu({ driverVersion: 'Y'.repeat(81) })));
});

test('inventory rejects a cudaVersion one character past Accelerator.cudaVersion VarChar(40)', () => {
  assert.throws(() => inventorySchema.parse(baseGpu({ cudaVersion: 'Z'.repeat(41) })));
});
