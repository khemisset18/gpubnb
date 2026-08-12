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
  assert.match(frame, /enqueueBoundedList\(redis,wsInputKey\(channelId\)/);
  assert.ok(
    frame.indexOf('activateGatewaySession') < frame.indexOf('enqueueBoundedList(redis,wsInputKey(channelId)'),
    'activation must succeed before a legacy frame enters the renter delivery queue',
  );

  const batchStart = source.indexOf("app.post('/agent/workspace-gateway/ws-frames'");
  const batchEnd = source.indexOf('\n  });', batchStart);
  const batch = source.slice(batchStart, batchEnd);
  assert.match(batch, /activateGatewaySession\(db,binding\.sessionId,machineId\)/);
  assert.match(batch, /ENQUEUE_DEDUPED_WS_FRAME_SCRIPT/);
  assert.ok(
    batch.indexOf('activateGatewaySession') < batch.indexOf('ENQUEUE_DEDUPED_WS_FRAME_SCRIPT'),
    'activation must succeed before a batched frame enters the renter delivery queue',
  );
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
  assert.match(body, /operational:neverActivated\?MachineOperational\.DEGRADED:MachineOperational\.AVAILABLE/);
});

test('verified Developer cleanup cannot release a machine while another runtime still owns it', async () => {
  const source = await readFile(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/agent/workspace-gateway/:sessionId/stopped'");
  assert.ok(start >= 0);
  const end = source.indexOf('\n  });', start);
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(body, /\$transaction\(asynctx=>/);
  assert.match(body, /workspaceSessions:\{none:\{id:\{not:row\.id\},status:\{in:\[/, 'another active workspace must block release');
  assert.match(body, /jobs:\{none:\{status:\{in:\[/, 'another active job must block release');
  assert.match(body, /listings:\{none:\{bookings:\{some:\{id:\{not:row\.bookingId\},status:\{in:\[/, 'another resource-locking booking must block release');
  assert.match(body, /moderationStatus:ModerationStatus\.CLEAR/, 'a quarantined machine must never be released');
  assert.match(body, /isolationLevel:Prisma\.TransactionIsolationLevel\.Serializable/, 'cleanup/release must be serialized against competing writers');
  assert.match(body, /machineReleased:release/, 'the response should expose whether the guarded release actually won');
  assert.doesNotMatch(body, /db\.machine\.update\(\{where:\{id:machineId\},data:\{operational:MachineOperational\.AVAILABLE/, 'unguarded release must never return');
});

test('generic compute start and metrics routes cannot bypass the Developer billing gate', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(source, /workspaceSlug.*developer|workspace.*slug.*developer/i);
  assert.match(source, /developer_workspace_uses_gateway|developer.*gateway/i);
});

test('the dev-bypass diagnostic reconciler never touches a booking with a real Developer session', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(source, /workspaceSessions:\s*\{\s*none:\s*\{\s*machineWorkspace:\s*\{\s*workspace:\s*\{\s*slug:\s*['"]developer['"]/s);
});
