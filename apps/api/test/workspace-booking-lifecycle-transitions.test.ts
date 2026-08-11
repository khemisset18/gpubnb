import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('runtime registration opens a bounded activation window without starting paid time', async () => {
  const source = await readFile(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/agent/workspace-gateway/:sessionId/register'");
  assert.ok(start >= 0);
  const end = source.indexOf('\n  });', start);
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(body, /firstRegistration=row\.status===WorkspaceSessionStatus\.READY&&typeofmetadata\?\.gatewayPath!==['"]string['"]/);
  assert.match(body, /activationDeadline=newDate\(readyAt\.getTime\(\)\+INTERACTIVE_CONNECT_TIMEOUT_SECONDS\*1000\)/);
  assert.match(body, /readyAt,startedAt:null,expiresAt:activationDeadline/);
  assert.doesNotMatch(body, /startedAt:readyAt/);
  assert.doesNotMatch(body, /status:WorkspaceSessionStatus\.RUNNING/);
  assert.match(
    body,
    /booking\.updateMany\(\{where:\{id:row\.bookingId,status:BookingStatus\.FUNDED\},data:\{status:BookingStatus\.STARTING,startsAt:readyAt,endsAt:activationDeadline/,
  );
});

test('grant consumption authenticates the browser but cannot activate or bill the booking', async () => {
  const source = await readFile(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.get('/workspace-gateway/:sessionId'");
  assert.ok(start >= 0);
  const end = source.indexOf('\n  });', start);
  const body = source.slice(start, end);

  assert.match(body, /consumeWorkspaceAccessGrant/);
  assert.match(body, /gatewaySessionKey\(browserToken\)/);
  assert.doesNotMatch(body, /WorkspaceSessionStatus\.RUNNING/);
  assert.doesNotMatch(body, /BookingStatus\.ACTIVE/);
  assert.doesNotMatch(body, /SESSION_STARTED/);
});

test('only the first authenticated upstream WebSocket frame starts paid time', async () => {
  const source = await readFile(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  const helperStart = source.indexOf('async function activateGatewaySession');
  const helperEnd = source.indexOf('\n}\n\nexport function registerWorkspaceGatewayRoutes', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd).replace(/\s+/g, '');

  assert.match(helper, /row\.status!==WorkspaceSessionStatus\.READY\|\|row\.booking\.status!==BookingStatus\.STARTING/);
  assert.match(helper, /status:WorkspaceSessionStatus\.RUNNING,startedAt:activatedAt,expiresAt/);
  assert.match(helper, /status:BookingStatus\.ACTIVE,startsAt:activatedAt,endsAt:expiresAt/);
  assert.match(helper, /action:'INTERACTIVE_WORKSPACE_CONNECTED'/);

  const frameStart = source.indexOf("app.post('/agent/workspace-gateway/ws-frame'");
  const frameEnd = source.indexOf('\n  });', frameStart);
  const frame = source.slice(frameStart, frameEnd);
  assert.match(frame, /binding\.machineId!==machineId/);
  assert.match(frame, /activateGatewaySession\(db,binding\.sessionId,machineId\)/);
  assert.ok(frame.indexOf('activateGatewaySession') < frame.indexOf('redis.lpush(wsInputKey'), 'activation must succeed before the frame reaches the renter');
});

test('developer usage remains zero while READY and increments only for RUNNING plus ACTIVE', async () => {
  const source = await readFile(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/agent/workspace-gateway/:sessionId/usage'");
  assert.ok(start >= 0);
  const end = source.indexOf('\n  });', start);
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(body, /pendingActivation=row\.status===WorkspaceSessionStatus\.READY&&row\.booking\.status===BookingStatus\.STARTING/);
  assert.match(body, /billable=row\.status===WorkspaceSessionStatus\.RUNNING&&row\.booking\.status===BookingStatus\.ACTIVE/);
  assert.match(body, /validIncrement:0,pendingActivation:true/);
  assert.match(body, /usage_counter_replay/);
  assert.match(body, /expectedSeconds-row\.booking\.validSeconds/);
});

test('a cleaned workspace that never became interactive is recorded as a failure', async () => {
  const source = await readFile(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/agent/workspace-gateway/:sessionId/stopped'");
  assert.ok(start >= 0);
  const end = source.indexOf('\n  });', start);
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(body, /neverActivated=row\.startedAt===null/);
  assert.match(body, /WorkspaceSessionStatus\.TIMED_OUT:WorkspaceSessionStatus\.COMPLETED/);
  assert.match(body, /status:BookingStatus\.DEGRADED/);
  assert.match(body, /status:PaymentStatus\.SETTLEMENT_PENDING/);
  assert.match(body, /INTERACTIVE_CONNECTION_NEVER_ESTABLISHED/);
});

test('generic compute start and metrics routes cannot bypass the Developer billing gate', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const guards = source.match(/machineWorkspace:\{workspace:\{slug:\{not:'developer'\}\}\}/g) ?? [];
  assert.equal(guards.length, 2);
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
