import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIVERY_LIMITS,
  canonicalJson,
  clampBatchSize,
  clampLeaseSeconds,
  payloadHash,
  retryDelaySeconds,
  shouldDeadLetter,
  validateMachineCommand,
  validateOutboxEnvelope,
} from '../src/reliable-delivery.js';

test('canonical payload hash is stable across key order', () => {
  assert.equal(payloadHash({ b: 2, a: 1 }), payloadHash({ a: 1, b: 2 }));
  assert.equal(canonicalJson({ b: [2, 1], a: true }), '{"a":true,"b":[2,1]}');
});

test('outbox validation rejects unsafe identifiers and oversized payloads', () => {
  const valid = {
    id: 'event_0001',
    topic: 'booking.events',
    aggregateType: 'booking',
    aggregateId: 'booking_0001',
    eventType: 'booking.funded',
    partitionKey: 'booking_0001',
    idempotencyKey: 'booking_0001_funded',
    payload: { bookingId: 'booking_0001' },
  };
  assert.equal(validateOutboxEnvelope(valid), valid);
  assert.throws(() => validateOutboxEnvelope({ ...valid, topic: '../admin' }), /outbox_topic_invalid/);
  assert.throws(
    () => validateOutboxEnvelope({ ...valid, payload: { value: 'x'.repeat(DELIVERY_LIMITS.maxPayloadBytes) } }),
    /delivery_payload_too_large/,
  );
});

test('machine commands require monotonic sequence and future expiry', () => {
  const now = new Date('2026-07-25T00:00:00.000Z');
  const command = {
    id: 'command_0001',
    machineId: 'machine_0001',
    commandType: 'rental.prepare',
    sequence: 1n,
    idempotencyKey: 'machine_0001_command_0001',
    expiresAt: new Date('2026-07-25T00:05:00.000Z'),
    payload: { reservationId: 'reservation_0001' },
  };
  assert.equal(validateMachineCommand(command, now), command);
  assert.throws(() => validateMachineCommand({ ...command, sequence: 0n }, now), /command_sequence_invalid/);
  assert.throws(
    () => validateMachineCommand({ ...command, expiresAt: new Date('2026-07-24T23:59:59.000Z') }, now),
    /command_expired/,
  );
});

test('retry policy is bounded and deterministic', () => {
  assert.equal(retryDelaySeconds(2, 'event_0001'), retryDelaySeconds(2, 'event_0001'));
  assert.ok(retryDelaySeconds(20, 'event_0001') <= 300);
  assert.equal(shouldDeadLetter(DELIVERY_LIMITS.maxAttempts - 1), false);
  assert.equal(shouldDeadLetter(DELIVERY_LIMITS.maxAttempts), true);
});

test('worker-controlled limits are clamped', () => {
  assert.equal(clampBatchSize(0, 500), 1);
  assert.equal(clampBatchSize(9999, 500), 500);
  assert.equal(clampLeaseSeconds(1, 120), 5);
  assert.equal(clampLeaseSeconds(9999, 120), 120);
});
