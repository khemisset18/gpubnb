import assert from 'node:assert/strict';
import test from 'node:test';

import { allWorkspaceCompatibility, compatibleWorkspaceChoices, isExecutableWorkspaceSlug } from '../src/machine-workspace-catalog.js';
import { desktopWorkspaceSlugs } from '../src/desktop-workspace-preview.js';

const capable = {
  ramTotalMiB: 65536, diskTotalMiB: 262144, vramMiB: 24576,
  cudaVersion: '12.4', dockerAvailable: true, nvidiaRuntimeAvailable: true,
  operatingSystem: 'Linux', virtualizationAvailable: false,
  desktopGpuRenderingAvailable: true,
};

function withPreview(nodeEnv: string, preview: string | undefined, fn: () => void) {
  const previousNode = process.env.NODE_ENV;
  const previousPreview = process.env.GPUBNB_DESKTOP_WORKSPACE_PREVIEW;
  try {
    process.env.NODE_ENV = nodeEnv;
    if (preview === undefined) delete process.env.GPUBNB_DESKTOP_WORKSPACE_PREVIEW;
    else process.env.GPUBNB_DESKTOP_WORKSPACE_PREVIEW = preview;
    fn();
  } finally {
    if (previousNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNode;
    if (previousPreview === undefined) delete process.env.GPUBNB_DESKTOP_WORKSPACE_PREVIEW;
    else process.env.GPUBNB_DESKTOP_WORKSPACE_PREVIEW = previousPreview;
  }
}

test('preview off: none of four desktop slugs is executable or bookable', () => {
  withPreview('production', 'true', () => {
    const catalogue = allWorkspaceCompatibility(capable);
    for (const slug of desktopWorkspaceSlugs) {
      assert.equal(isExecutableWorkspaceSlug(slug), false);
      assert.equal(catalogue.find(row => row.slug === slug)?.bookable, false);
    }
    assert.deepEqual(compatibleWorkspaceChoices(capable).map(row => row.slug), ['compute']);
  });
});

test('preview on: four slugs are offered only for qualified GPU rendering', () => {
  withPreview('test', 'true', () => {
    const list = compatibleWorkspaceChoices(capable);
    assert.deepEqual(list.map(row => row.slug), ['compute', 'cloud-desktop', 'creator', 'cad', 'gaming'].sort((a,b) => 0));
    for (const slug of desktopWorkspaceSlugs) {
      const item = allWorkspaceCompatibility(capable).find(row => row.slug === slug);
      assert.equal(item?.bookable, true, slug);
      assert.equal(isExecutableWorkspaceSlug(slug), true, slug);
    }
    const unrenderable = { ...capable, desktopGpuRenderingAvailable: false };
    for (const slug of desktopWorkspaceSlugs) {
      const item = allWorkspaceCompatibility(unrenderable).find(row => row.slug === slug);
      assert.equal(item?.bookable, false, slug);
    }
  });
});
