import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('settlement finalization is reachable via internal, token-protected routes', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');

  assert.ok(
    source.includes("import { requestSettlement, confirmSettlement } from './settlement-transactions.js';"),
    'settlement-transactions functions must be imported',
  );

  const requestRoute = source.indexOf("app.post('/internal/bookings/:id/settlement/request'");
  const confirmRoute = source.indexOf("app.post('/internal/bookings/:id/settlement/confirm'");
  assert.ok(requestRoute >= 0, 'settlement request route must exist');
  assert.ok(confirmRoute >= 0, 'settlement confirm route must exist');

  const requestHandler = source.slice(requestRoute, source.indexOf('\n', requestRoute));
  const confirmHandler = source.slice(confirmRoute, source.indexOf('\n', confirmRoute));

  // Both routes must gate on the internal service token before touching the db,
  // same pattern as the existing /internal/sweep-offline route.
  assert.ok(requestHandler.includes('constantTimeToken(req.headers.authorization'));
  assert.ok(requestHandler.includes('config.INTERNAL_SERVICE_TOKEN'));
  assert.ok(confirmHandler.includes('constantTimeToken(req.headers.authorization'));
  assert.ok(confirmHandler.includes('config.INTERNAL_SERVICE_TOKEN'));

  // And they must actually call through to the previously-unreachable, already-tested functions.
  assert.ok(requestHandler.includes('requestSettlement(db,id)'));
  assert.ok(confirmHandler.includes('confirmSettlement(db,id,signature)'));
});
