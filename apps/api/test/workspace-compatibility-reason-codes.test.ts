import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeWorkspace } from '../src/workspace-compatibility.js';
import { workspaceManifest } from '../src/workspace-manifests.js';

const capable = {
  ramTotalMiB: 65_536,
  diskTotalMiB: 2_000_000,
  vramMiB: 24_576,
  cudaVersion: '12.8',
  dockerAvailable: true,
  nvidiaRuntimeAvailable: true,
  operatingSystem: 'Windows',
  virtualizationAvailable: true,
  desktopGpuRenderingAvailable: true,
};

test('capable machine exposes stable positive capability codes', () => {
  const result = analyzeWorkspace(capable, workspaceManifest('ai')!);
  assert.equal(result.state, 'READY');
  assert.ok(result.reasonCodes.includes('VRAM_RECOMMENDED'));
  assert.ok(result.reasonCodes.includes('CUDA_AVAILABLE'));
  assert.ok(result.reasonCodes.includes('DOCKER_AVAILABLE'));
  assert.ok(result.reasonCodes.includes('NVIDIA_RUNTIME_AVAILABLE'));
  assert.deepEqual(result.missingCodes, []);
});

test('insufficient VRAM is machine-readable before booking', () => {
  const result = analyzeWorkspace(
    { ...capable, vramMiB: 512 },
    workspaceManifest('ai')!,
  );
  assert.equal(result.state, 'INCOMPATIBLE');
  assert.ok(result.missingCodes.includes('VRAM_BELOW_MINIMUM'));
});

test('missing Docker and NVIDIA runtime are distinct remediation reasons', () => {
  const result = analyzeWorkspace(
    { ...capable, dockerAvailable: false, nvidiaRuntimeAvailable: false },
    workspaceManifest('ai')!,
  );
  assert.ok(result.missingCodes.includes('DOCKER_REQUIRED'));
  assert.ok(result.missingCodes.includes('NVIDIA_RUNTIME_REQUIRED'));
});

test('unknown capacity is distinct from proven insufficient capacity', () => {
  const result = analyzeWorkspace(
    { ...capable, ramTotalMiB: null, diskTotalMiB: null, vramMiB: null },
    workspaceManifest('ai')!,
  );
  assert.ok(result.missingCodes.includes('RAM_NOT_MEASURED'));
  assert.ok(result.missingCodes.includes('DISK_NOT_MEASURED'));
  assert.ok(result.missingCodes.includes('VRAM_NOT_MEASURED'));
  assert.ok(!result.missingCodes.includes('VRAM_BELOW_MINIMUM'));
});
