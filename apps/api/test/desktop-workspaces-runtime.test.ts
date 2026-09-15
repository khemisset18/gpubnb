import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { allWorkspaceCompatibility, executableWorkspaceSlugs } from '../src/machine-workspace-catalog.js';

const desktopSlugs=['cloud-desktop','creator','cad','gaming'] as const;

const windowsLikeHost={
  ramTotalMiB:65536,
  diskTotalMiB:2_000_000,
  vramMiB:24576,
  cudaVersion:'13.1',
  dockerAvailable:true,
  nvidiaRuntimeAvailable:true,
  operatingSystem:'Windows',
  virtualizationAvailable:true,
  desktopGpuRenderingAvailable:false,
};

const linuxDesktopGpuHost={...windowsLikeHost,operatingSystem:'Linux',desktopGpuRenderingAvailable:true};

test('desktop/gaming runtimes are executable surfaces but stay unbookable without real desktop GPU rendering',()=>{
  for(const slug of desktopSlugs)assert.ok(executableWorkspaceSlugs.includes(slug));
  const catalogue=allWorkspaceCompatibility(windowsLikeHost);
  const bySlug=Object.fromEntries(catalogue.map(item=>[item.slug,item]));
  for(const slug of desktopSlugs){
    assert.equal(bySlug[slug].compatible,false,`${slug} must fail compatibility without desktop GPU rendering`);
    assert.equal(bySlug[slug].bookable,false,`${slug} must not become bookable on Windows/WSL2 merely because code exists`);
    assert.ok(bySlug[slug].compatibility.missing.length>0);
  }
});

test('desktop/gaming catalogue cards become bookable only when their real hardware requirements pass',()=>{
  const catalogue=allWorkspaceCompatibility(linuxDesktopGpuHost);
  const bySlug=Object.fromEntries(catalogue.map(item=>[item.slug,item]));
  for(const slug of desktopSlugs){
    assert.equal(bySlug[slug].compatible,true,`${slug} should pass the high-end Linux desktop GPU fixture`);
    assert.equal(bySlug[slug].bookable,true,`${slug} should be selectable once compatibility is genuinely proven`);
  }
});

test('desktop renter module exposes create, status and access routes for all four surfaces',async()=>{
  const source=await readFile(new URL('../src/desktop-workspace-routes.ts',import.meta.url),'utf8');
  for(const slug of desktopSlugs){
    assert.match(source,new RegExp(`workspace/\\$\\{slug\\}`));
    assert.match(source,new RegExp(`workspace/\\$\\{slug\\}/status`));
    assert.match(source,new RegExp(`workspace/\\$\\{slug\\}/access`));
  }
  assert.match(source,/ensureCompatibleMachineWorkspace/);
  assert.match(source,/type: JobType\.WORKSPACE_PREPARE/);
  assert.match(source,/parameters: \{ workspaceSlug: slug/);
  assert.match(source,/issueWorkspaceAccessGrant/);
  assert.match(source,/evaluateWorkspaceAccess/);
});

test('API gateway accepts the same four persistent desktop slugs',async()=>{
  const source=await readFile(new URL('../src/workspace-gateway.ts',import.meta.url),'utf8');
  for(const slug of desktopSlugs)assert.match(source,new RegExp(`['\"]${slug}['\"]`));
  assert.match(source,/slug:\{in:GATEWAY_WORKSPACE_SLUGS\}/);
});

test('desktop routes are registered in the application route graph',async()=>{
  const reconnect=await readFile(new URL('../src/workspace-reconnect-routes.ts',import.meta.url),'utf8');
  assert.match(reconnect,/registerDesktopWorkspaceRoutes\(app, db, redis\)/);
});
