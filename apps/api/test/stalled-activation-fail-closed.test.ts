import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function reconcilerBody(): Promise<string> {
  const source = await readFile(new URL('../src/dev-booking-reconciler.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function reconcileStalledActivations');
  assert.ok(start >= 0, 'stalled activation reconciler must exist');
  return source.slice(start);
}

test('stalled activation re-checks execution liveness inside a serializable, retry-wrapped transaction', async () => {
  const body = await reconcilerBody();
  // Real 500 found live during the PC A <-> PC B test (a different call site, same bug
  // class): a raw db.$transaction() with no retry surfaces a transient P2034 as an
  // unhandled 500 instead of recovering. reconcileStalledActivations now goes through
  // runBookingTransaction (booking-transaction-retry.ts) - same Serializable isolation,
  // just no longer unretried.
  assert.match(body, /runBookingTransaction\(db, async \(tx\) =>/);
  assert.doesNotMatch(body.slice(0, body.indexOf('export async function reconcileOrphanedDepositBookings')), /\bdb\.\$transaction\(/, 'must not also fall back to a raw, unretried db.$transaction()');
  assert.match(body, /tx\.job\.findMany/);
  assert.match(body, /job\.leaseExpiresAt !== null && job\.leaseExpiresAt > now/);
  assert.match(body, /if \(executionStillLive\) return false/);
  assert.match(body, /isolationLevel: 'Serializable'/);
});

test('expired claimed activation fails closed instead of releasing the machine', async () => {
  const body = await reconcilerBody();
  assert.match(body, /const claimedExecution = activeJobs\.some/);
  assert.match(body, /job\.currentAttemptId !== null \|\| job\.status !== JobStatus\.QUEUED/);
  // moderationStatus now flows through the shared enterQuarantine() helper (which
  // also appends a durable MachineQuarantineEvent history row) rather than a bare
  // literal column write - see quarantine-service.ts.
  assert.match(body, /await enterQuarantine\(tx, \{[\s\S]*?reasonCode: 'STALE_JOB'/);
  assert.match(body, /operational: MachineOperational\.UNAVAILABLE/);
  assert.ok(body.indexOf('if (claimedExecution)') < body.indexOf('MachineOperational.AVAILABLE'));
  assert.ok(body.indexOf('if (claimedExecution)') < body.indexOf("reasonCode: 'STALE_JOB'"));
});

test('only never-claimed work can release a machine and release is guarded by runtime absence', async () => {
  const body = await reconcilerBody();
  assert.match(body, /operational: MachineOperational\.RESERVED/);
  assert.match(body, /jobs: \{ none: \{ status: \{ in: ACTIVE_ACTIVATION_JOB_STATUSES \} \} \}/);
  assert.match(body, /workspaceSessions: \{ none: \{ status: \{ in: ACTIVE_DEVELOPER_SESSION_STATUSES \} \} \}/);
  assert.match(body, /data: \{ operational: MachineOperational\.AVAILABLE \}/);
});

test('stalled activation never claims financial success', async () => {
  const body = await reconcilerBody();
  assert.match(body, /status: BookingStatus\.DEGRADED/);
  assert.match(body, /status: PaymentStatus\.SETTLEMENT_PENDING/);
  assert.doesNotMatch(body, /status: PaymentStatus\.(?:RELEASED|PAID|COMPLETED)/);
});
