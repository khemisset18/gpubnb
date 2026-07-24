import { createHash } from 'node:crypto';

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,159}$/;
const SAFE_NAME = /^[a-z][a-z0-9._-]{1,119}$/;

export const DELIVERY_LIMITS = Object.freeze({
  outboxBatch: 500,
  machineCommandBatch: 100,
  maxAttempts: 12,
  minLeaseSeconds: 5,
  maxOutboxLeaseSeconds: 300,
  maxCommandLeaseSeconds: 120,
  maxPayloadBytes: 256 * 1024,
});

export type DeliveryStatus = 'PENDING' | 'LEASED' | 'PUBLISHED' | 'ACKNOWLEDGED' | 'EXPIRED' | 'DEAD';

export interface OutboxEnvelope {
  id: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  partitionKey: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface MachineCommandEnvelope {
  id: string;
  machineId: string;
  commandType: string;
  sequence: bigint;
  idempotencyKey: string;
  expiresAt: Date;
  payload: Record<string, unknown>;
}

export function validateDeliveryKey(value: string, field: string): string {
  if (!SAFE_KEY.test(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

export function validateTopic(value: string, field: string): string {
  if (!SAFE_NAME.test(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

export function validatePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, 'utf8') > DELIVERY_LIMITS.maxPayloadBytes) {
    throw new Error('delivery_payload_too_large');
  }
  if (Object.getPrototypeOf(payload) !== Object.prototype) {
    throw new Error('delivery_payload_invalid');
  }
  return payload;
}

export function validateOutboxEnvelope(envelope: OutboxEnvelope): OutboxEnvelope {
  validateDeliveryKey(envelope.id, 'outbox_id');
  validateTopic(envelope.topic, 'outbox_topic');
  validateTopic(envelope.aggregateType, 'outbox_aggregate_type');
  validateDeliveryKey(envelope.aggregateId, 'outbox_aggregate_id');
  validateTopic(envelope.eventType, 'outbox_event_type');
  validateDeliveryKey(envelope.partitionKey, 'outbox_partition_key');
  validateDeliveryKey(envelope.idempotencyKey, 'outbox_idempotency_key');
  validatePayload(envelope.payload);
  return envelope;
}

export function validateMachineCommand(
  command: MachineCommandEnvelope,
  now = new Date(),
): MachineCommandEnvelope {
  validateDeliveryKey(command.id, 'command_id');
  validateDeliveryKey(command.machineId, 'command_machine_id');
  validateTopic(command.commandType, 'command_type');
  validateDeliveryKey(command.idempotencyKey, 'command_idempotency_key');
  validatePayload(command.payload);
  if (command.sequence < 1n) {
    throw new Error('command_sequence_invalid');
  }
  if (!(command.expiresAt instanceof Date) || Number.isNaN(command.expiresAt.getTime())) {
    throw new Error('command_expiry_invalid');
  }
  if (command.expiresAt.getTime() <= now.getTime()) {
    throw new Error('command_expired');
  }
  return command;
}

export function payloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

export function retryDelaySeconds(attempt: number, entropy: string): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('delivery_attempt_invalid');
  }
  const cappedAttempt = Math.min(attempt, DELIVERY_LIMITS.maxAttempts);
  const base = Math.min(2 ** cappedAttempt, 300);
  const digest = createHash('sha256').update(entropy).digest();
  const jitter = digest.readUInt16BE(0) % Math.max(1, Math.floor(base / 4));
  return Math.min(base + jitter, 300);
}

export function shouldDeadLetter(attempts: number): boolean {
  return attempts >= DELIVERY_LIMITS.maxAttempts;
}

export function clampBatchSize(value: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(Math.max(Math.trunc(value), 1), maximum);
}

export function clampLeaseSeconds(value: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return DELIVERY_LIMITS.minLeaseSeconds;
  }
  return Math.min(Math.max(Math.trunc(value), DELIVERY_LIMITS.minLeaseSeconds), maximum);
}
