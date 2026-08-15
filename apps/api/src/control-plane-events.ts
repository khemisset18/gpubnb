import { randomBytes } from 'node:crypto';
import { canonicalJson, validatePayload } from './reliable-delivery.js';
import { stableShardFor } from './scalability.js';

// Keep partition keys within stableShardFor's 160-byte logical key limit.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,159}$/;
const SAFE_REGION = /^[a-z0-9][a-z0-9-]{1,31}$/;

export const CONTROL_PLANE_EVENT_SCHEMA_VERSION = 1;
export const CONTROL_PLANE_PARTITION_COUNT = 1024;
export const CONTROL_PLANE_MAX_EVENT_BYTES = 256 * 1024;

export const CONTROL_PLANE_EVENT_TYPES = Object.freeze([
  'machine.connected',
  'machine.presence.updated',
  'machine.disconnected',
  'machine.quarantined',
  'resource.lease.acquired',
  'resource.lease.renewed',
  'resource.lease.released',
  'rental.preemption.requested',
  'rental.preemption.completed',
  'rental.runtime.ready',
  'rental.runtime.stopped',
] as const);

export type ControlPlaneEventType = (typeof CONTROL_PLANE_EVENT_TYPES)[number];

export interface ControlPlaneEvent {
  schemaVersion: 1;
  eventId: string;
  eventType: ControlPlaneEventType;
  aggregateId: string;
  partitionKey: string;
  partition: number;
  region: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export function createControlPlaneEvent(input: {
  eventType: ControlPlaneEventType;
  aggregateId: string;
  partitionKey?: string;
  region: string;
  occurredAt?: Date;
  payload: Record<string, unknown>;
}): ControlPlaneEvent {
  validateEventType(input.eventType);
  validateId(input.aggregateId, 'control_plane_aggregate_id');
  const partitionKey = input.partitionKey ?? input.aggregateId;
  validateId(partitionKey, 'control_plane_partition_key');
  validateRegion(input.region);
  validatePayload(input.payload);
  const occurredAt = input.occurredAt ?? new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new Error('control_plane_event_time_invalid');

  const event: ControlPlaneEvent = {
    schemaVersion: CONTROL_PLANE_EVENT_SCHEMA_VERSION,
    eventId: `evt_${randomBytes(18).toString('base64url')}`,
    eventType: input.eventType,
    aggregateId: input.aggregateId,
    partitionKey,
    partition: stableShardFor(partitionKey, CONTROL_PLANE_PARTITION_COUNT),
    region: input.region,
    occurredAt: occurredAt.toISOString(),
    payload: input.payload,
  };
  assertControlPlaneEvent(event);
  return event;
}

export function assertControlPlaneEvent(value: ControlPlaneEvent): void {
  if (value.schemaVersion !== CONTROL_PLANE_EVENT_SCHEMA_VERSION) {
    throw new Error('control_plane_event_schema_invalid');
  }
  validateId(value.eventId, 'control_plane_event_id');
  validateEventType(value.eventType);
  validateId(value.aggregateId, 'control_plane_aggregate_id');
  validateId(value.partitionKey, 'control_plane_partition_key');
  validateRegion(value.region);
  if (!Number.isSafeInteger(value.partition) || value.partition < 0 || value.partition >= CONTROL_PLANE_PARTITION_COUNT) {
    throw new Error('control_plane_partition_invalid');
  }
  if (stableShardFor(value.partitionKey, CONTROL_PLANE_PARTITION_COUNT) !== value.partition) {
    throw new Error('control_plane_partition_mismatch');
  }
  const occurredAtMs = Date.parse(value.occurredAt);
  if (!Number.isFinite(occurredAtMs)) throw new Error('control_plane_event_time_invalid');
  validatePayload(value.payload);
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded, 'utf8') > CONTROL_PLANE_MAX_EVENT_BYTES) {
    throw new Error('control_plane_event_too_large');
  }
}

export function controlPlaneTopic(eventType: ControlPlaneEventType): string {
  validateEventType(eventType);
  const domain = eventType.split('.')[0];
  if (!domain) throw new Error('control_plane_event_type_invalid');
  return `gpubnb.control.${domain}.v1`;
}

function validateEventType(value: string): asserts value is ControlPlaneEventType {
  if (!(CONTROL_PLANE_EVENT_TYPES as readonly string[]).includes(value)) {
    throw new Error('control_plane_event_type_invalid');
  }
}

function validateId(value: string, error: string): void {
  if (!SAFE_ID.test(value)) throw new Error(error);
}

function validateRegion(value: string): void {
  if (!SAFE_REGION.test(value)) throw new Error('control_plane_region_invalid');
}
