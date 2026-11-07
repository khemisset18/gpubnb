import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  privateConsoleAgentCommit,
  privateConsoleDesiredFields,
  privateConsoleSessionMarker,
} from '../src/windows-native-private-console.js';

const SHA = 'f664a07ec500c57bf9a508838f51b7c0305ba92d';

test('console selection is disabled without explicit private flag and source pin', () => {
  assert.equal(privateConsoleAgentCommit({}), null);
  assert.equal(privateConsoleAgentCommit({
    GPUBNB_PRIVATE_CONSOLE_QUALIFICATION: 'true',
    GPUBNB_PRIVATE_CONSOLE_AGENT_COMMIT: 'not-a-sha',
  }), null);
  assert.equal(privateConsoleAgentCommit({
    GPUBNB_PRIVATE_CONSOLE_QUALIFICATION: 'false',
    GPUBNB_PRIVATE_CONSOLE_AGENT_COMMIT: SHA,
  }), null);
});

test('authorization requires private, no-payment config and exact running release SHA', () => {
  const authorized = {
    GPUBNB_PRIVATE_CONSOLE_QUALIFICATION: 'true',
    GPUBNB_PRIVATE_CONSOLE_AGENT_COMMIT: SHA,
    BETA_TEST_DEV_BYPASS: 'true',
    ESCROW_PROGRAM_ID: 'NOT_DEPLOYED_YET',
    RENDER_GIT_COMMIT: SHA,
  };
  assert.equal(privateConsoleAgentCommit(authorized), SHA);
  assert.equal(privateConsoleAgentCommit({ ...authorized, BETA_TEST_DEV_BYPASS: 'false' }), null);
  assert.equal(privateConsoleAgentCommit({ ...authorized, ESCROW_PROGRAM_ID: 'LIVE_PAYMENT_PROGRAM' }), null);
  assert.equal(privateConsoleAgentCommit({ ...authorized, RENDER_GIT_COMMIT: 'a'.repeat(40) }), null);
  assert.equal(privateConsoleAgentCommit({ ...authorized, RENDER_GIT_COMMIT: 'invalid' }), null);
  assert.equal(privateConsoleAgentCommit({ ...authorized, GPUBNB_PRIVATE_CONSOLE_AGENT_COMMIT: SHA.slice(0, 7) }), null);
  assert.equal(privateConsoleAgentCommit({ ...authorized, GPUBNB_PRIVATE_CONSOLE_QUALIFICATION: 'false' }), null);
});

test('only an exact, immutable server session marker can select console', () => {
  const limits = { privateConsoleQualification: privateConsoleSessionMarker(SHA) };
  assert.deepEqual(privateConsoleDesiredFields(limits, SHA), {
    captureBackend: 'console-dedicated',
    consoleAgentCommit: SHA,
  });
  for (const incorrect of [null, undefined, 'a'.repeat(40)]) {
    assert.deepEqual(privateConsoleDesiredFields(limits, incorrect), {
      captureBackend: 'console-authorization-invalid',
    });
  }
  assert.deepEqual(privateConsoleDesiredFields({}, SHA), {});
  assert.deepEqual(privateConsoleDesiredFields(null, SHA), {});
  assert.deepEqual(privateConsoleDesiredFields({
    privateConsoleQualification: { captureBackend: 'iddcx', agentCommit: SHA },
  }, SHA), { captureBackend: 'console-authorization-invalid' });
});

test('production IddCx and public listings do not acquire a console grant', () => {
  const api = readFileSync(new URL('../src/desktop-workspace-routes.ts', import.meta.url), 'utf8');
  const gateway = readFileSync(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  assert.match(api, /privateConsoleAgentCommit\(\)/);
  assert.match(api, /privateConsoleSessionMarker/);
  assert.match(gateway, /privateConsoleDesiredFields\(resourceLimits,approvedConsoleCommit\)/);
  assert.match(gateway, /authenticateAgent\(db,redis,machineId,request,route\)/);
  assert.doesNotMatch(api, /ListingStatus\.ACTIVE[^\n]*privateConsoleSessionMarker/);
});

test('private console qualification is owner-only at preflight, booking and session creation', () => {
  const api = readFileSync(new URL('../src/desktop-workspace-routes.ts', import.meta.url), 'utf8');
  const booking = api.slice(
    api.indexOf('async function createWindowsNativeQualificationBooking('),
    api.indexOf('async function createWindowsNativeQualificationSession('),
  );
  const session = api.slice(
    api.indexOf('async function createWindowsNativeQualificationSession('),
    api.indexOf('async function createDesktopWorkspaceSession('),
  );
  const preflight = api.slice(
    api.indexOf("app.get('/qualification/windows-native/preflight'"),
    api.indexOf("app.post('/qualification/windows-native/booking'"),
  );
  assert.match(booking, /source\.captureBackend !== 'console-dedicated' \|\| machine\.ownerId === renterId/);
  assert.match(booking, /freshSource\.captureBackend === 'console-dedicated' && fresh\.machine\.ownerId !== renterId/);
  assert.match(session, /qualifiedSource\.captureBackend !== 'console-dedicated' \|\| machine\.ownerId === renterId/);
  assert.match(preflight, /source\.captureBackend !== 'console-dedicated' \|\| host\.ownerId === session\.userId/);
});

test('console admission is signed, replay-fenced and independent from public listing availability', () => {
  const api = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/windows-native-private-console-proof.ts', import.meta.url), 'utf8');
  assert.match(api, /verifyAgentRequestV2/);
  assert.match(api, /verifiedConsoleProof\(b\.privateConsoleProof/);
  assert.match(api, /replaceConsoleProof\(redis,m\.id,verifiedConsole,String\(b\.counter\)\)/);
  assert.match(source, /latestAcceptedCounter/);
  assert.match(source, /CONSOLE_PROOF_TTL_SECONDS = 90/);
  assert.match(source, /private-console-proof:v1:/);
  assert.doesNotMatch(source, /gpuListing\.update/);
});

test('native buffered browser frames are individually revoked before send', () => {
  const gateway = readFileSync(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  const pump = gateway.slice(
    gateway.indexOf('const pump=setInterval('),
    gateway.indexOf('let browserSendChain:', gateway.indexOf('const pump=setInterval(')),
  );
  assert.match(pump, /for\(let i=0;i<50;i\+\+\)/);
  assert.match(pump, /withNativeGatewaySessionFence\(db,sessionId,row\.machineId,browser\.userId,row\.runtimeBackend,async isActive=>/);
  assert.match(pump, /NATIVE_DELIVERY_FENCE_SCRIPT,2,wsChannelKey\(channelId\),browserSessionKey,channelBinding,raw\)\)!==1\|\|!isActive\(\)/);
  const leaseGate = pump.indexOf('await redis.eval(NATIVE_DELIVERY_FENCE_SCRIPT');
  const send = pump.indexOf('ws.send(Buffer.from(parsed.dataBase64');
  assert.ok(leaseGate >= 0 && send > leaseGate);
  assert.match(pump, /ws\.close\(1008,'native workspace revoked'\)/);
  assert.match(gateway, /cacheMs: 0/);
});

test('native WebSocket close fences Redis immediately and pending batches stop before send', () => {
  const gateway = readFileSync(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  const pump = gateway.slice(
    gateway.indexOf('const pump=setInterval('),
    gateway.indexOf('let browserSendChain:', gateway.indexOf('const pump=setInterval(')),
  );
  assert.match(pump, /if\(browserClosed \|\| ws\.readyState!==WebSocket\.OPEN\)break/);
  assert.match(pump, /if\(!browserClosed && ws\.readyState===WebSocket\.OPEN\)/);
  const close = gateway.slice(gateway.indexOf("ws.on('close',(closeCode"), gateway.indexOf("});\n      });", gateway.indexOf("ws.on('close',(closeCode")));
  const immediateFence = close.indexOf('void redis.del(wsChannelKey(channelId),wsUpstreamReadyKey(channelId))');
  const queueClose = close.indexOf('void browserSendChain.then(');
  assert.ok(immediateFence >= 0 && queueClose > immediateFence,
    'closing a native WebSocket must revoke the Redis channel key before queued cleanup');
  const input = gateway.slice(gateway.indexOf("ws.on('message',(data:WebSocket.Data"), gateway.indexOf("ws.on('close',(closeCode"));
  assert.match(input, /enqueueAuthorizedNativeMachineRelay\(db,redis,sessionId,browser\.userId,row\.machineId,row\.runtimeBackend,channelId,channelBinding,browserSessionKey,relay\)/);
  assert.match(input, /enqueueMachineRelay\(redis,row\.machineId,relay\)/);
  assert.match(input, /browserClosed&&await enqueueAuthorizedNativeMachineRelay/);
});
