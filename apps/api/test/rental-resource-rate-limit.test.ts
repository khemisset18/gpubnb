import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('rental authority polling has a dedicated rate-limit budget', async () => {
  const source = await readFile(new URL('../src/rental-resource-routes.ts', import.meta.url), 'utf8');

  assert.match(source, /const RENTAL_AUTHORITY_RATE_LIMIT_PER_MINUTE = 180;/);
  assert.match(
    source,
    /app\.get\('\/agent\/mining\/:machineId\/rental-authority',\s*\{\s*config:\s*\{\s*rateLimit:\s*\{\s*max:\s*RENTAL_AUTHORITY_RATE_LIMIT_PER_MINUTE,\s*timeWindow:\s*'1 minute'/s,
  );
});
