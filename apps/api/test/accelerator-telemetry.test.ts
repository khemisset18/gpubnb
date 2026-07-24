import assert from 'node:assert/strict';
import test from 'node:test';
import { acceleratorFingerprint, primaryGpu, sanitizeAccelerators } from '../src/accelerator-telemetry.js';

const valid = {
  schemaVersion: 1 as const,
  kind: 'QPU',
  vendor: 'Open Quantum',
  model: 'OQ-1',
  deviceId: 'oq-1',
  available: true,
  capabilities: { physicalQubits: 64, topology: 'all-to-all' },
  metrics: { fidelityPercent: 99.91 },
};

test('accepts unknown future accelerator kinds', () => {
  const [item] = sanitizeAccelerators([valid]);
  assert.equal(item.kind, 'QPU');
  assert.equal(item.model, 'OQ-1');
});

test('rejects duplicate identities', () => {
  assert.throws(() => sanitizeAccelerators([valid, { ...valid, model: 'Renamed' }]), /duplicate_accelerator/);
});

test('rejects unsafe and unbounded metadata', () => {
  assert.throws(() => sanitizeAccelerators([{ ...valid, metrics: { constructor: 'bad' } }]), /unsafe_key/);
  const capabilities = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key${index}`, index]));
  assert.throws(() => sanitizeAccelerators([{ ...valid, capabilities }]), /too_many_keys/);
});

test('rejects impossible memory and metric values', () => {
  assert.throws(() => sanitizeAccelerators([{ ...valid, memoryTotalMiB: 10, memoryUsedMiB: 11 }]), /memory_used_exceeds_total/);
  assert.throws(() => sanitizeAccelerators([{ ...valid, utilizationPercent: 101 }]), /less than or equal to 100/);
  assert.throws(() => sanitizeAccelerators([{ ...valid, temperatureC: -274 }]), /greater than or equal to -273.15/);
});

test('selects a compatible primary GPU without excluding other devices', () => {
  const items = sanitizeAccelerators([
    valid,
    { ...valid, kind: 'GPU', vendor: 'Future Silicon', model: 'FS-9000', deviceId: 'gpu-1', memoryTotalMiB: 65536 },
  ]);
  assert.equal(primaryGpu(items)?.model, 'FS-9000');
  assert.equal(acceleratorFingerprint(items), 'GPU:future silicon:gpu-1|QPU:open quantum:oq-1');
});

test('rejects unknown top-level fields and excessive devices', () => {
  assert.throws(() => sanitizeAccelerators([{ ...valid, injected: true }]), /Unrecognized key/);
  assert.throws(
    () => sanitizeAccelerators(Array.from({ length: 257 }, (_, i) => ({ ...valid, deviceId: `qpu-${i}` }))),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      return error.message.includes('"code": "too_big"') && error.message.includes('"maximum": 256');
    },
  );
});
