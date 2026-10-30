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
