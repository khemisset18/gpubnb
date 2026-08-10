import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Found live: a booking funded for a Developer Workspace rental is deliberately excluded from
// reconcileDevelopmentBookings' GPU_DIAGNOSTIC path (a Developer rental has its own real
// lifecycle in workspace-gateway.ts). If the agent was offline/broken at the moment it should
// have picked up the workspace preparation - which happened repeatedly during installer/service
// troubleshooting on the test machine - that booking's status never advances, and it keeps
// counting against every future booking attempt on the same listing (time_slot_unavailable) for
// its entire original duration, up to 24h. reconcileStalledActivations is the safety-net
// timeout for exactly this: independent of BETA_TEST_DEV_BYPASS, unconditional in every
// environment.

test('reconcileStalledActivations degrades FUNDED/STARTING bookings whose start time is long past without reaching ACTIVE', async () => {
  const source = await readFile(new URL('../src/dev-booking-reconciler.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function reconcileStalledActivations');
  assert.ok(start >= 0, 'the stalled-activation reconciler must exist');
  const end = source.indexOf('\n}', source.indexOf('return { degraded }', start));
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(
    body,
    /status:\{in:\[BookingStatus\.FUNDED,BookingStatus\.STARTING\]\}/,
    'must only ever touch bookings that never reached ACTIVE - an ACTIVE booking is a renter actually using their session and must never be degraded here',
  );
  assert.match(
    body,
    /startsAt:\{lt:newDate\(now\.getTime\(\)-STALLED_ACTIVATION_GRACE_MS\)\}/,
    'must require a real grace period past the booking\'s own start time, not just "started in the past" (which is true for almost every legitimately in-progress booking)',
  );
  assert.match(
    body,
    /data:\{status:BookingStatus\.DEGRADED\}/,
    'a stalled activation must resolve to DEGRADED, not silently stay FUNDED/STARTING forever',
  );
  assert.match(
    body,
    /operational:MachineOperational\.RESERVED\},data:\{operational:MachineOperational\.AVAILABLE\}/,
    'freeing the stuck booking must also release the machine back to AVAILABLE, or the listing stays blocked even after the booking itself is degraded',
  );
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

  assert.match(line, /reconcileStalledActivations/, 'the stalled-activation reconciler must actually be wired into the running interval, not just defined and unused');
  assert.match(line, /Promise\.all\(/, 'both reconcilers must run concurrently on the same tick so one being slow does not delay the other');
});
