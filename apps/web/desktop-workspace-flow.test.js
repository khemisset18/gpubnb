import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_STREAMING_SLUGS, desktopWorkspacePhase, validDesktopSlug } from './desktop-workspace-flow.js';

test('four expected desktop surfaces and no path-injection slugs', () => {
  assert.deepEqual(DESKTOP_STREAMING_SLUGS, ['creator', 'cloud-desktop', 'cad', 'gaming']);
  for (const slug of DESKTOP_STREAMING_SLUGS) assert.equal(validDesktopSlug(slug), true);
  for (const slug of ['compute', 'developer', 'cloud-desktop/../access', '']) assert.equal(validDesktopSlug(slug), false);
});

test('only live validated access becomes an opening button', () => {
  for (const status of ['CREATED', 'AWAITING_DEPOSIT', 'COMPLETED', 'CANCELLED']) {
    assert.equal(desktopWorkspacePhase(status, { canOpen: true, status: 'READY' }), 'HIDDEN');
  }
  assert.equal(desktopWorkspacePhase('FUNDED', null), 'HIDDEN');
  assert.equal(desktopWorkspacePhase('STARTING', { status: 'READY', canOpen: false }), 'PREPARING');
  assert.equal(desktopWorkspacePhase('ACTIVE', { status: 'READY', canOpen: true }), 'OPEN');
  assert.equal(desktopWorkspacePhase('FUNDED', { status: 'FAILED', retryable: true }), 'RETRY');
  assert.equal(desktopWorkspacePhase('ACTIVE', { status: 'CANCELLED' }), 'ENDED');
});
