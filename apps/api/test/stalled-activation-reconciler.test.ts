import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// A funded Developer rental can stall before any Agent ever claims its workspace job.
// That is materially different from an expired claimed lease: never-claimed work proves
// no renter runtime started and may safely release its DB allocation, while claimed work
// must remain fail-closed until cleanup is proven.

test('reconcileStalledActivations degrades FUNDED/STARTING bookings whose start time is long past without reaching ACTIVE', async () => {
  const source = await readFile(new URL('../src/dev-booking-reconciler.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function reconcileStalledActivations');
  assert.ok(start >= 0, 'the stalled-activation reconciler must exist');
  const end = source.indexOf('\n}', source.indexOf('return { degraded }', start));
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(
    body,
    /status:\{in:\[BookingStatus\.FUNDED,BookingStatus\.STARTING\]\}/,
    'must only ever touch bookings that never reached ACTIVE',
  );
  assert.match(
    body,
    /startsAt:\{lt:newDate\(now\.getTime\(\)-STALLED_ACTIVATION_GRACE_MS\)\}/,
    'must require a real grace period past the booking start time',
  );
  assert.match(body, /data:\{status:BookingStatus\.DEGRADED\}/, 'a stalled activation must resolve to DEGRADED');
  assert.match(body, /constclaimedExecution=activeJobs\.some/, 'release policy must distinguish claimed from never-claimed execution');
  assert.match(
    body,
    /if\(claimedExecution\)\{.*operational:MachineOperational\.UNAVAILABLE.*enterQuarantine\(tx,\{machineId:booking\.listing\.machineId,reasonCode:'STALE_JOB'/s,
    'claimed execution with unproved cleanup must fail closed (via the shared enterQuarantine() helper, which also appends a durable MachineQuarantineEvent history row)',
  );
  assert.match(
    body,
    /tx\.machineAllocation\.updateMany\(\{where:\{bookingId:booking\.id,status:\{in:LIVE_ALLOCATION_STATUSES\}\},data:allocationData,\}\)/,
    'never-claimed work must release the whole-machine allocation',
  );
  assert.match(
    body,
    /tx\.acceleratorAllocation\.updateMany\(\{where:\{bookingId:booking\.id,status:\{in:LIVE_ALLOCATION_STATUSES\}\},data:allocationData,\}\)/,
    'never-claimed work must release accelerator allocations too',
  );
  assert.match(body, /status:ResourceAllocationStatus\.RELEASED/, 'released allocations must be terminal');
  assert.match(
    body,
    /jobs:\{none:\{status:\{in:ACTIVE_ACTIVATION_JOB_STATUSES\}\}\}.*workspaceSessions:\{none:/s,
    'AVAILABLE is allowed only after proving no other active job/session remains',
  );
  assert.match(body, /data:\{operational:MachineOperational\.AVAILABLE\}/, 'never-claimed stalled work may return a proven-idle machine to AVAILABLE');
});

test('the grace period is a real safety margin, not effectively zero', async () => {
  const source = await readFile(new URL('../src/dev-booking-reconciler.ts', import.meta.url), 'utf8');
  const match = source.match(/const STALLED_ACTIVATION_GRACE_MS\s*=\s*([0-9_]+)\s*\*\s*60_000/);
  assert.ok(match, 'grace period must be expressed in whole minutes for readability');
  const minutes = Number(match![1].replace(/_/g, ''));
  assert.ok(minutes >= 10, `grace period of ${minutes} minutes is too aggressive - a slow but legitimate workspace preparation could be wrongly degraded`);
});

test('the reconciliation interval runs both reconcilers on every tick, independently of each other failing', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const reconcileIntervalId=setInterval');
  assert.ok(start >= 0);
  const end = source.indexOf('\n', start);
  const line = source.slice(start, end);

  assert.match(line, /reconcileStalledActivations/, 'the stalled-activation reconciler must actually be wired into the running interval');
  assert.match(line, /Promise\.all\(/, 'both reconcilers must run concurrently on the same tick so one being slow does not delay the other');
});
