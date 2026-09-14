import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RELEASE_COMPATIBILITY_PROTOCOL,
  RELEASE_FEATURE_PROTOCOLS,
  compatibilityReason,
  evaluateComponentCompatibility,
  releaseCompatibilityDescriptor,
} from '../src/release-compatibility.js';

test('current component descriptor is compatible with itself', () => {
  const descriptor = releaseCompatibilityDescriptor();
  assert.equal(descriptor.releaseCompatibilityProtocol, RELEASE_COMPATIBILITY_PROTOCOL);
  assert.deepEqual(descriptor.features, RELEASE_FEATURE_PROTOCOLS);
  assert.deepEqual(evaluateComponentCompatibility(descriptor), { compatible: true, problems: [] });
});

test('missing compatibility metadata fails closed instead of assuming compatibility', () => {
  const result = evaluateComponentCompatibility(undefined);
  assert.equal(result.compatible, false);
  assert.ok(result.problems.some((problem) => problem.feature === 'releaseCompatibilityProtocol'));
  assert.match(compatibilityReason(result) ?? '', /^release_protocol_incompatible:/);
});

test('an older Host power-policy protocol is explicitly incompatible', () => {
  const descriptor = releaseCompatibilityDescriptor();
  descriptor.features.hostPowerPolicy = 0;
  const result = evaluateComponentCompatibility(descriptor);
  assert.equal(result.compatible, false);
  assert.deepEqual(result.problems.find((problem) => problem.feature === 'hostPowerPolicy'), {
    feature: 'hostPowerPolicy',
    required: 1,
    reported: 0,
  });
});

test('a missing feature protocol is reported as missing, never silently downgraded', () => {
  const descriptor = releaseCompatibilityDescriptor();
  delete descriptor.features.workspaceGateway;
  const result = evaluateComponentCompatibility(descriptor);
  assert.equal(result.compatible, false);
  assert.equal(
    result.problems.find((problem) => problem.feature === 'workspaceGateway')?.reported,
    null,
  );
});

test('unknown future compatibility protocol is not accepted by an older component', () => {
  const descriptor = releaseCompatibilityDescriptor();
  descriptor.releaseCompatibilityProtocol = RELEASE_COMPATIBILITY_PROTOCOL + 1;
  const result = evaluateComponentCompatibility(descriptor);
  assert.equal(result.compatible, false);
  assert.equal(result.problems[0]?.feature, 'releaseCompatibilityProtocol');
});
