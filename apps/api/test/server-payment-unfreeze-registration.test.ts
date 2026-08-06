import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('a frozen payment has a manual resolution path (C6)', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');

  const route = source.indexOf("app.post('/internal/bookings/:id/payment/unfreeze'");
  assert.ok(route >= 0, 'unfreeze route must exist');

  const handler = source.slice(route, source.indexOf('\n', route));
  assert.ok(handler.includes('constantTimeToken(req.headers.authorization'));
  assert.ok(handler.includes('config.INTERNAL_SERVICE_TOKEN'));
  // Must only ever move a payment OUT of FROZEN, and only if it was actually frozen —
  // never a blind status write that could resurrect a terminal/already-settled payment.
  assert.ok(handler.includes('status:PaymentStatus.FROZEN'));
  assert.ok(handler.includes('data:{status:PaymentStatus.ESCROW_FUNDED}'));
  assert.ok(handler.includes("updated.count!==1"));
});
