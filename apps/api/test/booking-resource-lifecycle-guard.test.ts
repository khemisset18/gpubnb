import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../prisma/migrations/20260812070000_guard_booking_resource_lifecycle/migration.sql',
  import.meta.url,
);

async function migrationSql(): Promise<string> {
  return readFile(migrationUrl, 'utf8');
}

test('terminal bookings cannot be resurrected into reserving or executing states', async () => {
  const sql = await migrationSql();

  assert.match(sql, /BEFORE UPDATE OF "status" ON "Booking"/);
  for (const terminal of ['COMPLETED', 'SETTLED', 'REFUNDED', 'CANCELLED']) {
    assert.match(sql, new RegExp(`OLD\\."status" IN \\([^)]*'${terminal}'`));
  }
  for (const target of ['CREATED', 'AWAITING_DEPOSIT', 'FUNDED', 'STARTING', 'ACTIVE', 'DEGRADED']) {
    assert.match(sql, new RegExp(`NEW\\."status" IN \\([^)]*'${target}'`));
  }
  assert.match(sql, /ERRCODE = '23514'/);
});

test('every paid or executing booking state requires a live resource allocation', async () => {
  const sql = await migrationSql();

  for (const status of ['FUNDED', 'STARTING', 'ACTIVE', 'DEGRADED']) {
    assert.match(sql, new RegExp(`NEW\\."status" IN \\([^)]*'${status}'`));
  }
  assert.match(sql, /FROM "MachineAllocation"/);
  assert.match(sql, /FROM "AcceleratorAllocation"/);
  assert.match(sql, /"status" IN \('HELD', 'CONFIRMED', 'ACTIVE'\)/);
  assert.match(sql, /cannot enter % without a live resource allocation/);
});

test('normal settlement transitions remain possible after completion', async () => {
  const sql = await migrationSql();
  const resurrectionTargets = sql.match(/NEW\."status" IN \(([^)]+)\)/)?.[1] ?? '';

  assert.doesNotMatch(resurrectionTargets, /'SETTLED'/);
  assert.doesNotMatch(resurrectionTargets, /'REFUNDED'/);
});
