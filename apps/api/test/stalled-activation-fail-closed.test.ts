import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function reconcilerBody(): Promise<string> {
  const source = await readFile(new URL('../src/dev-booking-reconciler.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function reconcileStalledActivations');
  assert.ok(start >= 0, 'stalled activation reconciler must exist');
  return source.slice(start);
}

test('stalled activation re-checks execution liveness inside a serializable transaction', async () => {
  const body = await reconcilerBody();
  assert.match(body, /\$transaction\(async \(tx\) =>/);
  assert.match(body, /tx\.job\.findMany/);
  assert.match(body, /job\.leaseExpiresAt !== null && job\.leaseExpiresAt > now/);
  assert.match(body, /if \(executionStillLive\) return false/);
  assert.match(body, /isolationLevel: 'Serializable'/);
});

test('expired claimed activation fails closed instead of releasing the machine', async () => {
  const body = await reconcilerBody();
  assert.match(body, /const claimedExecution = activeJobs\.some/);
  assert.match(body, /job\.currentAttemptId !== null \|\| job\.status !== JobStatus\.QUEUED/);
  assert.match(body, /moderationStatus: ModerationStatus\.QUARANTINED/);
  assert.match(body, /operational: MachineOperational\.UNAVAILABLE/);
  assert.ok(body.indexOf('if (claimedExecution)') < body.indexOf('MachineOperational.AVAILABLE'));
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
