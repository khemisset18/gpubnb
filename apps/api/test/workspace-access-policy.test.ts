import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {evaluateWorkspaceAccess} from '../src/workspace-access-policy.js';

const now=new Date('2026-08-09T12:00:00Z');
const valid={authenticatedUserId:'u1',renterId:'u1',bookingStatus:'FUNDED',sessionStatus:'READY',expiresAt:new Date('2026-08-09T13:00:00Z'),now,machineConnectivity:'ONLINE',machineOperational:'AVAILABLE',moderationStatus:'CLEAR',lastHeartbeatAt:new Date('2026-08-09T11:59:30Z'),heartbeatMaxAgeSeconds:120};

test('allows only a healthy ready renter session',()=>assert.deepEqual(evaluateWorkspaceAccess(valid),{allowed:true}));

test('rejects another user',()=>assert.deepEqual(evaluateWorkspaceAccess({...valid,authenticatedUserId:'attacker'}),{allowed:false,code:'NOT_RENTER'}));
test('rejects unready workspace',()=>assert.deepEqual(evaluateWorkspaceAccess({...valid,sessionStatus:'PREPARING'}),{allowed:false,code:'WORKSPACE_NOT_READY'}));
test('rejects expired session',()=>assert.deepEqual(evaluateWorkspaceAccess({...valid,expiresAt:now}),{allowed:false,code:'SESSION_EXPIRED'}));
test('rejects stale heartbeat',()=>assert.deepEqual(evaluateWorkspaceAccess({...valid,lastHeartbeatAt:new Date('2026-08-09T11:50:00Z')}),{allowed:false,code:'HEARTBEAT_STALE'}));
test('rejects quarantined machine',()=>assert.deepEqual(evaluateWorkspaceAccess({...valid,machineOperational:'QUARANTINED'}),{allowed:false,code:'MACHINE_BLOCKED'}));

// Real bug found live (2026-09-02): a real agent's heartbeats land 28-40s apart
// (measured from this exact machine's own agent.log - the agent's own system/GPU
// inventory collection dominates its nominal 10s loop interval, not just clock
// skew), but every /bookings/:id/workspace(/:slug)/{status,access} route used to
// pass the *unrelated* clock-skew-on-submission constant (25s) as this policy's
// heartbeatMaxAgeSeconds. That made "Ouvrir mon espace" - and a real open attempt -
// intermittently fail with HEARTBEAT_STALE on a perfectly healthy, actively
// heartbeating machine. This must never regress to a threshold tighter than real
// observed cadence.
test('a 35s-old heartbeat - representative of real agent cadence, not just clock skew - must still be accepted', () => {
  assert.deepEqual(
    evaluateWorkspaceAccess({ ...valid, lastHeartbeatAt: new Date(now.getTime() - 35_000), heartbeatMaxAgeSeconds: 55 }),
    { allowed: true },
  );
});

test('workspace-renter-routes.ts wires a heartbeat threshold wide enough for real agent cadence, never the tighter clock-skew-on-submission constant', () => {
  const source = readFileSync(new URL('../src/workspace-renter-routes.ts', import.meta.url), 'utf8');
  const occurrences = source.match(/heartbeatMaxAgeSeconds:\s*config\.(\w+)/g) ?? [];
  assert.ok(occurrences.length >= 16, 'every workspace status/access route must set heartbeatMaxAgeSeconds');
  for (const occurrence of occurrences) {
    assert.match(occurrence, /config\.WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS$/, `${occurrence} must use the dedicated workspace-access threshold, not the unrelated submission-time clock-skew constant`);
  }
});
