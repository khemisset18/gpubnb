import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Real gap found during this session's audit: POST /bookings/:bookingId/workspace/developer
// read the booking's status (findFirst) BEFORE its own $transaction, with no re-check at
// write time. reconcileExpiredActiveDeveloperBookings (dev-booking-reconciler.ts) ticks
// independently every ~10s and can complete/free that exact booking - status ACTIVE -> COMPLETED,
// machine RESERVED -> AVAILABLE - in the gap between that read and this write, so a
// WorkspaceSession could in principle get created against a booking that had just ended.
//
// Fixed with the same atomic conditional-updateMany idiom already used throughout
// dev-booking-reconciler.ts: an `UPDATE ... WHERE id=? AND status IN (...) AND endsAt > now`
// takes Postgres's row lock immediately, so it is naturally mutually exclusive with the
// reconciler's own conditional updateMany on the same booking row under the DB's default
// (READ COMMITTED) isolation - whichever transaction's UPDATE commits first is the one whose
// WHERE the loser re-evaluates against. No real Postgres is available in this environment to
// drive that interleaving end-to-end (this repo's few tests that need one - e.g.
// quarantine-diagnostics-system.test.ts - skip via a hasDb guard), so this test verifies, by
// reading the real route source (same technique the existing adjacent test in
// developer-booking-diagnostic-race.test.ts already uses for this same route), that: the
// re-check happens inside the transaction, before the session is created (not after - a
// post-create check would leave an orphaned session on the losing branch), gates on both
// status and endsAt, and that losing the race returns a clean, typed rejection rather than an
// unhandled throw.

test('workspace/developer atomically re-verifies the booking (status + endsAt) inside its own transaction, before creating the session', async () => {
  const source = await readFile(new URL('../src/workspace-renter-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/bookings/:bookingId/workspace/developer'");
  const end = source.indexOf("app.post('/bookings/:bookingId/workspace/retry'", start);
  assert.ok(start >= 0 && end > start, 'developer workspace route not found');
  const body = source.slice(start, end);
  const compact = body.replace(/\s+/g, '');

  const transactionStart = compact.indexOf('db.$transaction(asynctx=>{');
  assert.ok(transactionStart >= 0, 'route must create the session inside a transaction');
  const recheckIndex = compact.indexOf('tx.booking.updateMany(', transactionStart);
  const createIndex = compact.indexOf('tx.workspaceSession.create(', transactionStart);
  assert.ok(recheckIndex >= 0, 'transaction must atomically re-verify the booking before creating a session');
  assert.ok(createIndex >= 0, 'transaction must still create the workspace session');
  assert.ok(
    recheckIndex < createIndex,
    'the atomic re-check must run BEFORE the session is created - checking after would leave an orphaned session on the losing branch',
  );

  const recheckCall = compact.slice(recheckIndex, createIndex);
  assert.match(
    recheckCall,
    /status:\{in:activeBookings\}/,
    'the atomic re-check must gate on the same FUNDED\\/STARTING\\/ACTIVE set as the pre-transaction read and the frontend\'s eligibility set',
  );
  assert.match(
    recheckCall,
    /endsAt:\{gt:newDate\(\)\}/,
    'the atomic re-check must reject a booking whose rental window has already elapsed, even if its status row has not been swept to COMPLETED yet',
  );
  assert.match(
    recheckCall,
    /buyerId:session\.userId/,
    'the atomic re-check must stay scoped to the requesting renter - not just any booking by this id',
  );
  assert.match(
    recheckCall,
    /if\(stillEligible\.count!==1\)thrownewBookingNoLongerEligibleForWorkspaceError\(\)/,
    'losing the race must throw a distinguishable, typed error - not silently proceed to create an orphaned session',
  );

  // The catch block must turn that typed error into a clean, documented rejection - and must
  // still prefer the pre-existing raced-session recovery first, so a genuine double-click
  // (test H) is unaffected: two concurrent requests that both pass the atomic re-check still
  // race on workspaceSession's own @@unique([bookingId, machineWorkspaceId]) constraint, and
  // the loser there must keep recovering the winner's session, not surface this new error.
  const catchIndex = compact.indexOf('}catch(error){', transactionStart);
  assert.ok(catchIndex >= 0, 'route must still catch transaction failures');
  // compact is already bounded to just this route (sliced up to the next route
  // registration above), so running to the end of the string is safe here and avoids
  // false-terminating on a nested call's own closing "});" inside the catch body.
  const catchBody = compact.slice(catchIndex);
  const racedIndex = catchBody.indexOf('if(raced)returnraced;');
  const typedErrorIndex = catchBody.indexOf('BookingNoLongerEligibleForWorkspaceError');
  assert.ok(racedIndex >= 0 && typedErrorIndex >= 0, 'catch block must check both the raced-session recovery and the new typed rejection');
  assert.ok(racedIndex < typedErrorIndex, 'a genuine double-click must still recover the winner\'s session before this new rejection is even considered');
  assert.match(
    catchBody,
    /errorinstanceofBookingNoLongerEligibleForWorkspaceError\)returnreply\.code\(409\)\.send\(\{error:'funded_booking_required'\}\)/,
    'losing the atomic re-check must return the same documented 409 reason as the initial pre-transaction gate, not an unhandled 500',
  );
});
