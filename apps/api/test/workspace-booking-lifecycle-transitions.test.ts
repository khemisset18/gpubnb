import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Before this, a Developer booking never left FUNDED and its session never left
// READY for its entire lifetime: only /agent/workspace-sessions/:id/metrics (which
// Developer runtimes never call) advanced either. These tests guard the two points
// that now give the flow real STARTING/RUNNING/ACTIVE signal, matching
// booking FUNDED -> STARTING -> ... -> renter opens -> ACTIVE.

test('the first successful runtime registration moves the session to RUNNING and the booking to STARTING', async () => {
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
  assert.match(
    body,
    /status:WorkspaceSessionStatus\.RUNNING/,
    'READY only ever meant "prepared" - the runtime actually being up and healthy is what RUNNING should mean',
  );
  assert.match(
    body,
    /booking\.updateMany\(\{where:\{id:row\.bookingId,status:BookingStatus\.FUNDED\},data:\{status:BookingStatus\.STARTING\}/,
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
    /booking\.updateMany\(\{where:\{id:row\.bookingId,status:BookingStatus\.STARTING\},data:\{status:BookingStatus\.ACTIVE\}/,
    'ACTIVE should mean the renter is actually in their workspace, not merely that it was prepared',
  );
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
