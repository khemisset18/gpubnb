import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveReleaseIdentity } from '../src/release-identity.js';

test('release identity prefers explicit provider-neutral override', () => {
  const identity = resolveReleaseIdentity({
    GPUBNB_RELEASE_SHA: 'A'.repeat(40),
    RENDER_GIT_COMMIT: 'b'.repeat(40),
    GITHUB_SHA: 'c'.repeat(40),
  });
  assert.deepEqual(identity, {
    commit: 'a'.repeat(40),
    source: 'GPUBNB_RELEASE_SHA',
  });
});

test('release identity uses the Render deployment commit in production', () => {
  const identity = resolveReleaseIdentity({ RENDER_GIT_COMMIT: 'B'.repeat(40) });
  assert.deepEqual(identity, {
    commit: 'b'.repeat(40),
    source: 'RENDER_GIT_COMMIT',
  });
});

test('release identity accepts GitHub SHA for CI and rejects ambiguous values', () => {
  assert.deepEqual(resolveReleaseIdentity({ GITHUB_SHA: 'c'.repeat(40) }), {
    commit: 'c'.repeat(40),
    source: 'GITHUB_SHA',
  });
  assert.deepEqual(resolveReleaseIdentity({ RENDER_GIT_COMMIT: 'abc1234' }), {
    commit: null,
    source: null,
  });
});
