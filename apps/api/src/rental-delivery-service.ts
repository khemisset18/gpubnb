import crypto from 'node:crypto';
import {
  appendOutboxEvent,
  enqueueMachineCommand,
  nextMachineSequence,
  type SqlClient,
} from './delivery-store.js';
import type { MachineCommandEnvelope, OutboxEnvelope } from './reliable-delivery.js';

export type RentalEventType =
  | 'booking.created'
  | 'booking.funded'
  | 'rental.preparation_requested'
  | 'rental.start_requested'
  | 'rental.stop_requested'
  | 'rental.completed'
  | 'payment.settlement_requested'
  | 'payment.settled'
  | 'payment.refunded';

export type MachineRentalCommandType =
  | 'prepare_rental'
  | 'start_rental'
  | 'stop_rental'
  | 'cleanup_rental';

export interface RentalDeliveryContext {
  bookingId: string;
  machineId: string;
  renterId: string;
  listingId?: string;
  sessionId?: string;
  paymentId?: string;
  startsAt?: Date;
  endsAt?: Date;
}

export interface DeliveryWriteResult {
  eventId: string;
  commandId?: string;
  sequence?: bigint;
}

const SAFE_CUID = /^c[a-z0-9]{20,31}$/;

function assertCuid(value: string, field: string): string {
  if (!SAFE_CUID.test(value)) throw new Error(`${field}_invalid`);
  return value;
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
}

function dateValue(value?: Date): string | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('delivery_date_invalid');
  return value.toISOString();
}

function cleanPayload(context: RentalDeliveryContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  assertCuid(context.bookingId, 'booking_id');
  assertCuid(context.machineId, 'machine_id');
  assertCuid(context.renterId, 'renter_id');
  if (context.listingId) assertCuid(context.listingId, 'listing_id');
  if (context.sessionId) assertCuid(context.sessionId, 'session_id');
  if (context.paymentId) assertCuid(context.paymentId, 'payment_id');

  return {
    bookingId: context.bookingId,
    machineId: context.machineId,
    renterId: context.renterId,
    ...(context.listingId ? { listingId: context.listingId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.paymentId ? { paymentId: context.paymentId } : {}),
    ...(context.startsAt ? { startsAt: dateValue(context.startsAt) } : {}),
    ...(context.endsAt ? { endsAt: dateValue(context.endsAt) } : {}),
    ...extra,
  };
}

export async function recordRentalEvent(
  tx: SqlClient,
  eventType: RentalEventType,
  context: RentalDeliveryContext,
  extra: Record<string, unknown> = {},
): Promise<DeliveryWriteResult> {
  const payload = cleanPayload(context, extra);
  const eventId = stableId('evt', context.bookingId, eventType);
  const envelope: OutboxEnvelope = {
    id: eventId,
    topic: eventType.startsWith('payment.') ? 'payments' : 'rentals',
    aggregateType: eventType.startsWith('payment.') ? 'payment' : 'booking',
    aggregateId: context.paymentId ?? context.bookingId,
    eventType,
    partitionKey: context.machineId,
    idempotencyKey: `${context.bookingId}:${eventType}`,
    payload,
    headers: { schemaVersion: '1' },
  };
  await appendOutboxEvent(tx, envelope);
  return { eventId };
}

export async function recordRentalEventAndCommand(
  tx: SqlClient,
  eventType: RentalEventType,
  commandType: MachineRentalCommandType,
  context: RentalDeliveryContext,
  expiresAt: Date,
  extra: Record<string, unknown> = {},
): Promise<DeliveryWriteResult> {
  const payload = cleanPayload(context, extra);
  const sequence = await nextMachineSequence(tx, context.machineId);
  const eventId = stableId('evt', context.bookingId, eventType);
  const commandId = stableId('cmd', context.machineId, context.bookingId, commandType);

  const event: OutboxEnvelope = {
    id: eventId,
    topic: 'rentals',
    aggregateType: 'booking',
    aggregateId: context.bookingId,
    eventType,
    partitionKey: context.machineId,
    idempotencyKey: `${context.bookingId}:${eventType}`,
    payload,
    headers: { schemaVersion: '1' },
  };
  const command: MachineCommandEnvelope = {
    id: commandId,
    machineId: context.machineId,
    commandType,
    sequence,
    idempotencyKey: `${context.bookingId}:${commandType}`,
    expiresAt,
    payload,
  };

  await appendOutboxEvent(tx, event);
  await enqueueMachineCommand(tx, command);
  return { eventId, commandId, sequence };
}

export async function requestPreparation(tx: SqlClient, context: RentalDeliveryContext): Promise<DeliveryWriteResult> {
  return recordRentalEventAndCommand(
    tx,
    'rental.preparation_requested',
    'prepare_rental',
    context,
    context.startsAt ?? new Date(Date.now() + 15 * 60_000),
  );
}

export async function requestRentalStart(tx: SqlClient, context: RentalDeliveryContext): Promise<DeliveryWriteResult> {
  return recordRentalEventAndCommand(
    tx,
    'rental.start_requested',
    'start_rental',
    context,
    context.endsAt ?? new Date(Date.now() + 60 * 60_000),
  );
}

export async function requestRentalStop(
  tx: SqlClient,
  context: RentalDeliveryContext,
  reason: 'renter' | 'owner' | 'platform',
): Promise<DeliveryWriteResult> {
  return recordRentalEventAndCommand(
    tx,
    'rental.stop_requested',
    'stop_rental',
    context,
    new Date(Date.now() + 5 * 60_000),
    { reason },
  );
}

export async function requestCleanup(tx: SqlClient, context: RentalDeliveryContext): Promise<DeliveryWriteResult> {
  return recordRentalEventAndCommand(
    tx,
    'rental.completed',
    'cleanup_rental',
    context,
    new Date(Date.now() + 15 * 60_000),
  );
}
