import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Regression for a real finding from RC1 Phase 5 concurrent-booking chaos testing:
// firing two overlapping POST /bookings at the same time can make Prisma's
// Serializable transaction fail with its own internal message (observed live:
// "Transaction API error: Unable to start a transaction in the given time.")
// instead of the intended time_slot_unavailable business error. The route used
// to forward e.message straight to the client for ANY transaction failure.

test('POST /bookings only forwards known business errors to the client, and rethrows anything else (C-concurrent-booking)', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');

  assert.ok(
    source.includes("import { runBookingTransaction, BOOKING_BUSINESS_ERRORS } from './booking-transaction-retry.js';"),
    'the /bookings route must reuse the shared retry+known-error module rather than reimplementing it inline',
  );

  const route = source.indexOf("app.post('/bookings',");
  assert.ok(route >= 0);
  const routeEnd = source.indexOf("app.post('/bookings/:id/payment-intent'", route);
  assert.ok(routeEnd > route);
  const routeBody = source.slice(route, routeEnd);

  assert.ok(
    routeBody.includes('await runBookingTransaction(db,async tx=>'),
    'the /bookings transaction must go through the retrying wrapper, not a bare db.$transaction call',
  );

  assert.ok(
    routeBody.includes('if(!BOOKING_BUSINESS_ERRORS.has(msg)){req.log.error({err:e},') &&
      routeBody.includes('throw e;'),
    'an unrecognized transaction failure (Prisma timeouts, connection errors, etc.) must be logged server-side and rethrown to the global error handler, never forwarded verbatim as the client-facing error code',
  );

  for (const known of ['time_slot_unavailable', 'listing_unavailable', 'quote_too_small']) {
    assert.ok(
      routeBody.includes(`throw new Error('${known}')`),
      `expected business error '${known}' referenced in the route must remain listed in BOOKING_BUSINESS_ERRORS`,
    );
  }
});
