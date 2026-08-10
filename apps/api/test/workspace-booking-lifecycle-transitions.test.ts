import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Before this, a Developer booking never left FUNDED and its session never left
// READY for its entire lifetime: only /agent/workspace-sessions/:id/metrics (which
// Developer runtimes never call) advanced either. These tests guard the two points
// that now give the flow real STARTING/RUNNING/ACTIVE signal, matching
// booking FUNDED -> STARTING -> ... -> renter opens -> ACTIVE.

test('runtime registration starts the purchased duration exactly when it becomes openable', async () => {
  const source = await readFile(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/agent/workspace-gateway/:sessionId/register'");
  assert.ok(start >= 0);
  const end = source.indexOf('\n  });', start);
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(
    body,
    /firstRegistration=row\.status===WorkspaceSessionStatus\.READY/,
    'must distinguish "first time this session is confirmed running" from a routine re-register (e.g. after an agent restart adopts the same container)',
  );
  assert.doesNotMatch(body, /status:WorkspaceSessionStatus\.RUNNING/);
  assert.match(body, /readyAt,startedAt:readyAt,expiresAt:rentalEndsAt/);
  assert.match(body, /endsAt:rentalEndsAt/);
  assert.match(
    body,
    /booking\.updateMany\(\{where:\{id:row\.bookingId,status:BookingStatus\.FUNDED\},data:\{status:BookingStatus\.STARTING,startsAt:readyAt,endsAt:rentalEndsAt/,
    'the booking must advance out of FUNDED once the workspace is actually running, not stay there for the whole rental',
  );
});

test('the renter actually opening the workspace moves the booking from STARTING to ACTIVE', async () => {
  const source = await readFile(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.get('/workspace-gateway/:sessionId'");
  assert.ok(start >= 0);
  const end = source.indexOf('\n  });', start);
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(
    body,
    /status:WorkspaceSessionStatus\.RUNNING,preparationStep:'RENTER_CONNECTED'/,
    'opening changes access state without resetting the clock that began at READY',
  );
  assert.match(
    body,
    /booking\.updateMany\(\{where:\{id:row\.bookingId,status:\{in:\[BookingStatus\.FUNDED,BookingStatus\.STARTING\]\}\},data:\{status:BookingStatus\.ACTIVE\}/,
    'ACTIVE should mean the renter is actually in their workspace, not merely that it was prepared',
  );
});

test('developer usage is accepted only after the workspace is ready and billable', async () => {
  const source = await readFile(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/agent/workspace-gateway/:sessionId/usage'");
  assert.ok(start >= 0);
  const end = source.indexOf('\n  });', start);
  const body = source.slice(start, end).replace(/\s+/g, '');
  assert.match(body, /status:\{in:\[WorkspaceSessionStatus\.READY,WorkspaceSessionStatus\.RUNNING\]\}/);
  assert.match(body, /row\.booking\.status!==BookingStatus\.STARTING&&row\.booking\.status!==BookingStatus\.ACTIVE/);
  assert.match(body, /usage_counter_replay/);
  assert.match(body, /expectedSeconds-row\.booking\.validSeconds/);
});

test('the dev-bypass diagnostic reconciler never touches a booking with a real Developer session', async () => {
  const source = await readFile(new URL('../src/dev-booking-reconciler.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const readyBookings = await db.booking.findMany({');
  assert.ok(start >= 0);
  const end = source.indexOf('\n  });', start);
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(
    body,
    /workspaceSessions:\{none:\{machineWorkspace:\{workspace:\{slug:'developer'\}\}\}\}/,
    'without this exclusion, this dev-test shortcut would run an unrelated GPU_DIAGNOSTIC job and mark a real Developer rental booking COMPLETED/DEGRADED out from under the renter',
  );
});
