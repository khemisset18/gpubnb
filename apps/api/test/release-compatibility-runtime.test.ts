import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  evaluateReportedCompatibility,
  releaseCompatibilityMode,
} from '../src/release-compatibility-policy.js';
import { releaseCompatibilityDescriptor } from '../src/release-compatibility.js';

const ROOT = new URL('../', import.meta.url);
const read = (path: string) => readFile(new URL(path, ROOT), 'utf8');

test('current signed descriptor is compatible', () => {
  const result = evaluateReportedCompatibility(releaseCompatibilityDescriptor());
  assert.equal(result.compatible, true);
  assert.equal(result.reason, null);
  assert.deepEqual(result.reported, releaseCompatibilityDescriptor());
});

test('missing, malformed, old and future descriptors fail closed as incompatible evidence', () => {
  for (const reported of [
    undefined,
    {},
    { releaseCompatibilityProtocol: 0, features: releaseCompatibilityDescriptor().features },
    { releaseCompatibilityProtocol: 2, features: releaseCompatibilityDescriptor().features },
    {
      releaseCompatibilityProtocol: 1,
      features: { ...releaseCompatibilityDescriptor().features, workspaceGateway: 999 },
    },
  ]) {
    const result = evaluateReportedCompatibility(reported);
    assert.equal(result.compatible, false);
    assert.match(result.reason ?? '', /^release_protocol_incompatible:/);
  }
});

test('rollout is observe by default and enforce only by explicit switch', () => {
  assert.equal(releaseCompatibilityMode({}), 'observe');
  assert.equal(releaseCompatibilityMode({ GPUBNB_RELEASE_COMPATIBILITY_MODE: 'observe' }), 'observe');
  assert.equal(releaseCompatibilityMode({ GPUBNB_RELEASE_COMPATIBILITY_MODE: 'ENFORCE' }), 'enforce');
  assert.equal(releaseCompatibilityMode({ GPUBNB_RELEASE_COMPATIBILITY_MODE: 'anything-else' }), 'observe');
});

test('runtime hook only acts after accepted heartbeat serialization and never hooks STOP/cleanup routes', async () => {
  const source = await read('src/release-compatibility-runtime.ts');
  assert.match(source, /request\.routeOptions\.url !== '\/agent\/heartbeat'/);
  assert.match(source, /reply\.statusCode >= 300/);
  assert.match(source, /MachineOperational\.UNAVAILABLE/);
  assert.match(source, /ListingStatus\.HIDDEN_OFFLINE/);
  assert.doesNotMatch(source, /workspace-sessions\/:id\/stop/);
  assert.doesNotMatch(source, /releaseBookingResources/);
  assert.doesNotMatch(source, /cancelBookingResources/);
});

test('device authorization root registers compatibility runtime before route modules', async () => {
  const source = await read('src/device-authorization-routes.ts');
  const compat = source.indexOf('registerReleaseCompatibilityRuntime(app, db, redis)');
  const marketplace = source.indexOf('registerRentalMarketplaceRoutes(app, db, redis)');
  assert.ok(compat > 0);
  assert.ok(marketplace > compat);
});

test('new allocation rejects UNAVAILABLE while release/cancel transitions remain ungated', async () => {
  const source = await read('src/resource-allocation-service.ts');
  const allocation = source.slice(
    source.indexOf('async function allocateInTransaction'),
    source.indexOf('export async function allocateBookingResources'),
  );
  const release = source.slice(source.indexOf('export async function releaseBookingResources'));
  assert.match(allocation, /operational:\s*true/);
  assert.match(allocation, /MachineOperational\.UNAVAILABLE/);
  assert.doesNotMatch(release, /MachineOperational\.UNAVAILABLE/);
});
