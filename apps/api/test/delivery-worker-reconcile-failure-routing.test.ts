import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Regression found during the final QA audit of feat/beta-readiness-hardening:
// reconcileDevelopmentBookings() failures inside main()'s loop were caught and
// logged locally, but never rethrown — so they never reached the FailureTracker
// that drives bounded backoff + give-up-and-restart (Priority 2). A persistent
// reconcile-specific failure (distinct from a general DB outage, which
// claimOutboxEvents right after it would also hit and correctly trip the tracker)
// could therefore fail silently forever with no automated recovery path. main()
// connects to a real DB/Redis and isn't unit-tested directly (same as its existing
// structure), so this is a source-inspection check, same convention as the
// existing C7/GPU-exclusivity/settlement-confirm route-wiring tests.

test('a reconcileDevelopmentBookings failure is logged then rethrown, not silently swallowed', async () => {
  const source = await readFile(new URL('../src/delivery-worker.ts', import.meta.url), 'utf8');
  const catchStart = source.indexOf("message: 'gpu_booking_reconcile_failed'");
  assert.ok(catchStart >= 0, 'reconcile failure log line not found');
  const window = source.slice(catchStart, catchStart + 800);
  assert.ok(
    window.includes('throw error;'),
    'a reconcile failure must be rethrown after logging, so it reaches the same catch/backoff/give-up logic as claimOutboxEvents — never swallowed indefinitely',
  );
});

test('lastReconcileAt is updated before the attempt, not only on success, so a failing reconcile is retried at the normal interval rather than every loop tick', async () => {
  const source = await readFile(new URL('../src/delivery-worker.ts', import.meta.url), 'utf8');
  const ifStart = source.indexOf('if (now - lastReconcileAt >= RECONCILE_INTERVAL_MS)');
  assert.ok(ifStart >= 0);
  const tryStart = source.indexOf('try {', ifStart);
  const between = source.slice(ifStart, tryStart);
  assert.ok(between.includes('lastReconcileAt = now;'), 'lastReconcileAt must be set before the reconcile attempt, not only in a success path');
});
