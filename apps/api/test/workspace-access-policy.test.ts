import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateWorkspaceAccess} from '../src/workspace-access-policy.js';

const now=new Date('2026-08-09T12:00:00Z');
const valid={authenticatedUserId:'u1',renterId:'u1',bookingStatus:'FUNDED',sessionStatus:'READY',expiresAt:new Date('2026-08-09T13:00:00Z'),now,machineConnectivity:'ONLINE',machineOperational:'AVAILABLE',moderationStatus:'CLEAR',lastHeartbeatAt:new Date('2026-08-09T11:59:30Z'),heartbeatMaxAgeSeconds:120};

test('allows only a healthy ready renter session',()=>assert.deepEqual(evaluateWorkspaceAccess(valid),{allowed:true}));

test('rejects another user',()=>assert.deepEqual(evaluateWorkspaceAccess({...valid,authenticatedUserId:'attacker'}),{allowed:false,code:'NOT_RENTER'}));
test('rejects unready workspace',()=>assert.deepEqual(evaluateWorkspaceAccess({...valid,sessionStatus:'PREPARING'}),{allowed:false,code:'WORKSPACE_NOT_READY'}));
test('rejects expired session',()=>assert.deepEqual(evaluateWorkspaceAccess({...valid,expiresAt:now}),{allowed:false,code:'SESSION_EXPIRED'}));
test('rejects stale heartbeat',()=>assert.deepEqual(evaluateWorkspaceAccess({...valid,lastHeartbeatAt:new Date('2026-08-09T11:50:00Z')}),{allowed:false,code:'HEARTBEAT_STALE'}));
test('rejects quarantined machine',()=>assert.deepEqual(evaluateWorkspaceAccess({...valid,machineOperational:'QUARANTINED'}),{allowed:false,code:'MACHINE_BLOCKED'}));
