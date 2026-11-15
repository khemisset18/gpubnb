import assert from 'node:assert/strict';
import test from 'node:test';
import {
  desktopWorkspacePreviewEnabled,
  desktopWorkspaceSlugs,
  isDesktopWorkspaceSlug,
} from '../src/desktop-workspace-preview.js';

test('four and only four desktop streaming surfaces are recognized', () => {
  assert.deepEqual(desktopWorkspaceSlugs, ['creator', 'cloud-desktop', 'cad', 'gaming']);
  for (const slug of desktopWorkspaceSlugs) assert.equal(isDesktopWorkspaceSlug(slug), true);
  for (const slug of ['developer', 'compute', 'admin', '../cad', '', 'cloud-desktop/..']) {
    assert.equal(isDesktopWorkspaceSlug(slug), false);
  }
});

test('preview is fail-closed unless explicitly opted in outside production', () => {
  for (const env of [
    {},
    { NODE_ENV: 'production', GPUBNB_DESKTOP_WORKSPACE_PREVIEW: 'true' },
    { NODE_ENV: 'development' },
    { NODE_ENV: 'test', GPUBNB_DESKTOP_WORKSPACE_PREVIEW: 'TRUE' },
    { NODE_ENV: 'staging', GPUBNB_DESKTOP_WORKSPACE_PREVIEW: 'true' },
  ]) assert.equal(desktopWorkspacePreviewEnabled(env), false);
  for (const env of [
    { NODE_ENV: 'test', GPUBNB_DESKTOP_WORKSPACE_PREVIEW: 'true' },
    { NODE_ENV: 'development', GPUBNB_DESKTOP_WORKSPACE_PREVIEW: 'true' },
  ]) assert.equal(desktopWorkspacePreviewEnabled(env), true);
});
