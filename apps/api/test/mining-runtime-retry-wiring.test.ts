import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function compact(value: string): string {
  return value.replace(/\s+/g, '');
}

test('mining runtime verifies the agent before entering the retried transaction', async () => {
  const source = await readFile(new URL('../src/mining-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/internal/mining/runtime-events'");
  assert.ok(start >= 0);
  const body = source.slice(start);
  const verifyIndex = body.indexOf('verifyAgentRequestV2');
  const retryIndex = body.indexOf('runBookingTransaction(db');

  assert.ok(verifyIndex >= 0 && retryIndex > verifyIndex);
  const retriedBody = body.slice(retryIndex);
  assert.doesNotMatch(retriedBody, /verifyAgentRequestV2/);
  assert.doesNotMatch(retriedBody, /recordSecurityFailure\(redis/);
});

test('mining runtime retry is bounded and protected by the event idempotency key', async () => {
  const source = await readFile(new URL('../src/mining-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/internal/mining/runtime-events'");
  assert.ok(start >= 0);
  const body = compact(source.slice(start));

  assert.match(body, /runBookingTransaction\(db,async\(tx\)=>/);
  assert.match(body, /WHEREe\."idempotencyKey"=\$\{event\.idempotencyKey\}/);
  assert.match(body, /if\(existing\.length\)/);
  assert.match(body, /returnfalse/);
  assert.match(body, /isolationLevel:Prisma\.TransactionIsolationLevel\.Serializable/);
  assert.match(body, /maxWait:5_000/);
  assert.match(body, /timeout:10_000/);
});
