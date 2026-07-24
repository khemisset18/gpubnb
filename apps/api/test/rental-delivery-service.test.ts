import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordRentalEvent,
  requestPreparation,
  requestRentalStop,
  type RentalDeliveryContext,
} from '../src/rental-delivery-service.js';

const context: RentalDeliveryContext = {
  bookingId: 'cm8abcdefghijklmnopqrstuv',
  machineId: 'cm8bcdefghijklmnopqrstuvw',
  renterId: 'cm8cdefghijklmnopqrstuvwx',
  listingId: 'cm8defghijklmnopqrstuvwxy',
  sessionId: 'cm8efghijklmnopqrstuvwxyz',
  startsAt: new Date('2026-08-01T10:00:00.000Z'),
  endsAt: new Date('2026-08-01T12:00:00.000Z'),
};

test('records a deterministic outbox event', async () => {
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const tx = {
    async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      statements.push({ query: strings.join('?'), values });
      return 1;
    },
    async $queryRaw<T>() {
      return [] as T;
    },
  };

  const first = await recordRentalEvent(tx, 'booking.created', context);
  const second = await recordRentalEvent(tx, 'booking.created', context);

  assert.equal(first.eventId, second.eventId);
  assert.equal(statements.length, 2);
  assert.match(statements[0]!.query, /OutboxEvent/);
});

test('preparation reserves an ordered command and matching event', async () => {
  const statements: string[] = [];
  const tx = {
    async $executeRaw(strings: TemplateStringsArray) {
      statements.push(strings.join('?'));
      return 1;
    },
    async $queryRaw<T>(strings: TemplateStringsArray) {
      statements.push(strings.join('?'));
      return [{ sequence: 42n }] as T;
    },
  };

  const result = await requestPreparation(tx, context);

  assert.equal(result.sequence, 42n);
  assert.match(result.eventId, /^evt_[0-9a-f]{32}$/);
  assert.match(result.commandId!, /^cmd_[0-9a-f]{32}$/);
  assert.equal(statements.filter((item) => item.includes('OutboxEvent')).length, 1);
  assert.equal(statements.filter((item) => item.includes('MachineCommand')).length, 1);
});

test('stop requests are reason-bound and idempotent', async () => {
  const writes: unknown[][] = [];
  const tx = {
    async $executeRaw(_strings: TemplateStringsArray, ...values: unknown[]) {
      writes.push(values);
      return 1;
    },
    async $queryRaw<T>() {
      return [{ sequence: 7n }] as T;
    },
  };

  const result = await requestRentalStop(tx, context, 'owner');
  const encoded = writes.flat().filter((value): value is string => typeof value === 'string');

  assert.equal(result.sequence, 7n);
  assert(encoded.some((value) => value.includes('owner')));
  assert(encoded.some((value) => value.includes('rental.stop_requested')));
  assert(encoded.some((value) => value.includes('stop_rental')));
});

test('rejects malformed identifiers before database writes', async () => {
  let touched = false;
  const tx = {
    async $executeRaw() {
      touched = true;
      return 1;
    },
    async $queryRaw<T>() {
      touched = true;
      return [] as T;
    },
  };

  await assert.rejects(
    () => recordRentalEvent(tx, 'booking.created', { ...context, machineId: 'bad' }),
    /machine_id_invalid/,
  );
  assert.equal(touched, false);
});
