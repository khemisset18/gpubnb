import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BATCH_SIZE,
  RETENTION_DAYS,
  assertRetentionPolicy,
  boundedBatchSize,
  normalizeCursorPage,
  stableShardFor,
  validateIdempotencyKey,
} from '../src/scalability.js';

test('cursor pagination is bounded and deterministic', () => {
  assert.deepEqual(normalizeCursorPage({}), { limit: 50 });
  assert.deepEqual(normalizeCursorPage({ limit: 200, cursor: 'next_001' }), {
    limit: 200,
    cursor: 'next_001',
  });
  assert.throws(() => normalizeCursorPage({ limit: 201 }), /invalid_page_size/);
  assert.throws(() => normalizeCursorPage({ cursor: '../admin' }), /invalid_cursor/);
});

test('idempotency keys reject weak or injectable values', () => {
  assert.equal(validateIdempotencyKey('booking:buyer_01:request_0001'), 'booking:buyer_01:request_0001');
  assert.throws(() => validateIdempotencyKey('short'), /invalid_idempotency_key/);
  assert.throws(() => validateIdempotencyKey('request;drop table'), /invalid_idempotency_key/);
});

test('batch sizes are capped to protect workers', () => {
  assert.equal(boundedBatchSize(25), 25);
  assert.equal(boundedBatchSize(50_000), MAX_BATCH_SIZE);
  assert.throws(() => boundedBatchSize(0), /invalid_batch_size/);
});

test('stable shard assignment is repeatable and bounded', () => {
  const first = stableShardFor('machine_001', 128);
  const second = stableShardFor('machine_001', 128);
  assert.equal(first, second);
  assert.ok(first >= 0 && first < 128);
  assert.notEqual(stableShardFor('machine_002', 128), first);
});

test('billing evidence outlives raw telemetry', () => {
  assertRetentionPolicy();
  assert.ok(RETENTION_DAYS.usageSampleBilling > RETENTION_DAYS.heartbeatRaw);
  assert.ok(RETENTION_DAYS.usageSampleBilling > RETENTION_DAYS.workspaceMetricRaw);
});
