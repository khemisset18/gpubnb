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
