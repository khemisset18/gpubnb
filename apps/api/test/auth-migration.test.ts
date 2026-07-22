import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../prisma/migrations/0003_multi_identity_auth/migration.sql', import.meta.url);

test('multi-identity migration is transactional and preserves legacy business rows', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /\bBEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.doesNotMatch(sql, /(?:DELETE\s+FROM|DROP\s+TABLE)\s+"(?:User|Booking|Payment|GpuListing|Machine)"/i);
  assert.match(sql, /INSERT INTO "AuthIdentity"/);
  assert.match(sql, /INSERT INTO "UserWallet"/);
  assert.match(sql, /ON CONFLICT \("provider", "subject"\) DO NOTHING/);
  assert.match(sql, /ON CONFLICT \("address"\) DO NOTHING/);
});

test('multi-identity migration refuses ambiguous or invalid legacy pseudonyms', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /GROUP BY lower\("pseudonym"\) HAVING count\(\*\) > 1/);
  assert.match(sql, /Invalid legacy pseudonym detected/);
  assert.match(sql, /User_pseudonym_case_insensitive_key/);
});
