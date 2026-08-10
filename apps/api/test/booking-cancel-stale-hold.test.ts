import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Found live: a renter whose payment-intent failed (escrow not deployed on this environment)
// was left with an AWAITING_DEPOSIT booking that could never be funded, and nothing let them
// release it - it kept counting against future time_slot_unavailable overlap checks on that
// listing forever. Cancelling must stay scoped to AWAITING_DEPOSIT only: once a real deposit
// or workspace runtime exists, a renter must not be able to unilaterally cancel out from under
// escrowed funds or a running container.

test('POST /bookings/:id/cancel only ever transitions AWAITING_DEPOSIT bookings, owned by the caller', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/bookings/:id/cancel'");
  assert.ok(start >= 0, 'the cancel route must exist');
  const end = source.indexOf('\n', start);
  const line = source.slice(start, end).replace(/\s+/g, '');

  assert.match(
    line,
    /buyerId:s\.userId,status:BookingStatus\.AWAITING_DEPOSIT/,
    'the update must be scoped to the caller\'s own bookings and only while still AWAITING_DEPOSIT - a FUNDED booking has real escrowed money and must never be cancellable through this route',
  );
  assert.match(
    line,
    /data:\{status:BookingStatus\.CANCELLED\}/,
    'cancelling must set status to CANCELLED',
  );
  assert.match(
    line,
    /updated\.count!==1.*reply\.code\(409\)/,
    'attempting to cancel a booking that is not AWAITING_DEPOSIT (or not owned by the caller) must fail loudly, not silently no-op',
  );
});

test('the booking overlap check excludes CANCELLED, so a cancelled hold frees its time slot', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const overlap=await tx.booking.count');
  assert.ok(start >= 0);
  const end = source.indexOf('\n', start);
  const line = source.slice(start, end);

  assert.match(
    line,
    /status:\{in:\[BookingStatus\.AWAITING_DEPOSIT,BookingStatus\.FUNDED,BookingStatus\.STARTING,BookingStatus\.ACTIVE\]\}/,
    'CANCELLED (and terminal statuses) must not be in the overlap set, or cancelling would never actually free the slot',
  );
});

test('the dashboard exposes listing.id on each booking, not just its title', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.get('/dashboard'");
  assert.ok(start >= 0);
  const end = source.indexOf('\n', start);
  const line = source.slice(start, end);

  assert.match(
    line,
    /listing:\{select:\{id:true,title:true\}\}/,
    'a client recovering from time_slot_unavailable needs listing.id to know which of its own pending bookings to cancel - title alone is not a safe match key',
  );
});
