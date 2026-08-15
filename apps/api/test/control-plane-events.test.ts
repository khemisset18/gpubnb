import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_PLANE_PARTITION_COUNT,
  assertControlPlaneEvent,
  controlPlaneTopic,
  createControlPlaneEvent,
} from '../src/control-plane-events.js';

test('control-plane events are versioned, bounded and deterministically partitioned', () => {
  const first = createControlPlaneEvent({
    eventType: 'machine.connected',
    aggregateId: 'machine_00000001',
    region: 'eu-west',
    occurredAt: new Date('2026-08-15T00:00:00.000Z'),
    payload: { gatewayId: 'gateway_eu_0001' },
  });
  const second = createControlPlaneEvent({
    eventType: 'machine.presence.updated',
    aggregateId: 'machine_00000001',
    region: 'eu-west',
    occurredAt: new Date('2026-08-15T00:00:01.000Z'),
    payload: { phase: 'AVAILABLE' },
  });

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.partition, second.partition);
  assert.ok(first.partition >= 0 && first.partition < CONTROL_PLANE_PARTITION_COUNT);
  assert.notEqual(first.eventId, second.eventId);
  assert.equal(controlPlaneTopic(first.eventType), 'gpubnb.control.machine.v1');
  assert.doesNotThrow(() => assertControlPlaneEvent(first));
});

test('control-plane event validation fails closed on routing or schema tampering', () => {
  const event = createControlPlaneEvent({
    eventType: 'resource.lease.acquired',
    aggregateId: 'gpu:machine_0001:0',
    partitionKey: 'gpu:machine_0001:0',
    region: 'us-east',
    payload: { fencingToken: '42' },
  });

  assert.throws(
    () => assertControlPlaneEvent({ ...event, partition: (event.partition + 1) % CONTROL_PLANE_PARTITION_COUNT }),
    /control_plane_partition_mismatch/,
  );
  assert.throws(
    () => createControlPlaneEvent({ ...event, eventType: 'machine.connected', region: '../invalid' }),
    /control_plane_region_invalid/,
  );
});

test('control-plane payloads cannot become an unbounded event-bus transport', () => {
  assert.throws(
    () => createControlPlaneEvent({
      eventType: 'machine.presence.updated',
      aggregateId: 'machine_00000002',
      region: 'ap-south',
      payload: { blob: 'x'.repeat(300 * 1024) },
    }),
    /delivery_payload_too_large|control_plane_event_too_large/,
  );
});
