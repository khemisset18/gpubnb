import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function compact(value: string): string {
  return value.replace(/\s+/g, '');
}

test('exact GPU listing creation uses bounded retry while preserving the machine advisory lock', async () => {
  const source = await readFile(new URL('../src/rental-listing-service.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function createExactGpuListing');
  assert.ok(start >= 0);
  const body = compact(source.slice(start));

  assert.match(body, /runBookingTransaction\(db,async\(tx\)=>/);
  assert.match(body, /pg_advisory_xact_lock\(hashtextextended\(\$\{input\.machineId\},0\)\)/);
  assert.match(body, /isolationLevel:Prisma\.TransactionIsolationLevel\.Serializable/);
  assert.match(body, /maxWait:5_000/);
  assert.match(body, /timeout:10_000/);
});

test('owner listing lifecycle retries both serialized machine-scoped transitions', async () => {
  const source = await readFile(new URL('../src/rental-listing-lifecycle.ts', import.meta.url), 'utf8');
  const body = compact(source);

  const retries = body.match(/runBookingTransaction\(db,async\(tx\)=>/g) ?? [];
  assert.equal(retries.length, 2);

  const locks = body.match(/pg_advisory_xact_lock\(hashtextextended\(\$\{identity\.machineId\},0\)\)/g) ?? [];
  assert.equal(locks.length, 2);

  const serializable = body.match(/isolationLevel:Prisma\.TransactionIsolationLevel\.Serializable/g) ?? [];
  assert.equal(serializable.length, 2);

  const maxWait = body.match(/maxWait:5_000/g) ?? [];
  assert.equal(maxWait.length, 2);
  const timeout = body.match(/timeout:10_000/g) ?? [];
  assert.equal(timeout.length, 2);
});
