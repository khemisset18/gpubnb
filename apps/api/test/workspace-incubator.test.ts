import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workspaceManifests } from '../src/workspace-manifests.js';
import { workspaceRuntimeProfiles } from '../src/workspace-runtime-profiles.js';
import { executableWorkspaceSlugs, allWorkspaceCompatibility } from '../src/machine-workspace-catalog.js';

const contract = JSON.parse(readFileSync(new URL('../../../workspaces/incubator/candidates.json', import.meta.url), 'utf8')) as {
  neverBookable: boolean;
  candidates: Array<{slug:string;status:string;bookable:boolean;release:string;network:string}>;
};
const expected = ['ai-image-studio','llm-studio','voice-ai-studio','ai-training-studio','render-3d-studio','game-server-studio'];

test('exactly six design-only studio contracts and no accidental promotion', () => {
  assert.equal(contract.neverBookable, true);
  assert.deepEqual(contract.candidates.map(x => x.slug), expected);
  assert.equal(workspaceManifests.length, 19);
  assert.equal(executableWorkspaceSlugs.length, 9);
  for (const item of contract.candidates) {
    const manifest = workspaceManifests.find(x => x.slug === item.slug);
    const profile = workspaceRuntimeProfiles[item.slug];
    assert.ok(manifest, item.slug);
    assert.ok(profile, item.slug);
    assert.equal(manifest.release, 'UPCOMING');
    assert.equal(item.status, 'DESIGN_ONLY');
    assert.equal(item.bookable, false);
    assert.equal(profile.runtime, 'CONTAINER');
    assert.equal(profile.hostAccess, false);
    assert.equal(profile.dockerSocket, false);
    assert.equal(profile.privileged, false);
    assert.equal(profile.network, item.network);
    assert.equal(manifest.minimum.docker, true);
    assert.equal(executableWorkspaceSlugs.includes(item.slug as never), false);
  }
});

test('catalogue can explain requirements without exposing candidate studios for booking', () => {
  const machine = {ramTotalMiB:65536,diskTotalMiB:2_000_000,vramMiB:24576,cudaVersion:'12.8',dockerAvailable:true,nvidiaRuntimeAvailable:true,operatingSystem:'Linux',virtualizationAvailable:true,desktopGpuRenderingAvailable:true};
  const choices = allWorkspaceCompatibility(machine);
  assert.equal(choices.length, 19);
  for (const item of contract.candidates) {
    const choice = choices.find(x => x.slug === item.slug);
    assert.ok(choice, item.slug);
    assert.equal(choice?.bookable, false);
  }
});

test('game server networking remains explicitly non-executable and non-public', () => {
  const game = contract.candidates.find(x => x.slug === 'game-server-studio');
  assert.ok(game);
  assert.equal(game?.network, 'NONE');
  assert.equal(executableWorkspaceSlugs.includes('game-server-studio' as never), false);
});
