import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../prisma/migrations/20260725123000_atomic_booking_allocation_sync/migration.sql',
  import.meta.url,
);

async function migrationSql(): Promise<string> {
  return readFile(migrationUrl, 'utf8');
}

test('database trigger covers every resource-locking booking state', async () => {
  const sql = await migrationSql();

  for (const status of ['AWAITING_DEPOSIT', 'FUNDED', 'STARTING', 'ACTIVE', 'DEGRADED']) {
    assert.match(sql, new RegExp(`WHEN '${status}'`));
  }

  assert.match(sql, /WHEN 'FUNDED' THEN 'CONFIRMED'/);
  assert.match(sql, /WHEN 'STARTING' THEN 'CONFIRMED'/);
  assert.match(sql, /WHEN 'ACTIVE' THEN 'ACTIVE'/);
  assert.match(sql, /WHEN 'DEGRADED' THEN 'ACTIVE'/);
});

test('database trigger releases or cancels allocations for every terminal booking state', async () => {
  const sql = await migrationSql();

  for (const status of ['COMPLETED', 'SETTLED', 'REFUNDED']) {
    assert.match(sql, new RegExp(`WHEN '${status}' THEN 'RELEASED'`));
  }
  assert.match(sql, /WHEN 'CANCELLED' THEN 'CANCELLED'/);
  assert.match(sql, /COALESCE\("releasedAt", CURRENT_TIMESTAMP\)/);
});

test('synchronization is transaction-scoped, serialized per machine, and idempotent', async () => {
  const sql = await migrationSql();

  assert.match(sql, /AFTER UPDATE OF "status" ON "Booking"/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(target_machine_id, 0\)\)/);
  assert.match(sql, /NEW\."status" IS NOT DISTINCT FROM OLD\."status"/);
  assert.match(sql, /"status" IN \('HELD', 'CONFIRMED', 'ACTIVE'\)/);
  assert.doesNotMatch(sql, /UPDATE "Booking"/);
});

test('moving a booking backwards cannot resurrect a terminal allocation', async () => {
  const sql = await migrationSql();

  assert.match(sql, /IF target_status = 'HELD'.*RETURN NEW;/s);
  assert.match(sql, /WHERE "bookingId" = NEW\."id" AND "status" = 'HELD'/);
});
