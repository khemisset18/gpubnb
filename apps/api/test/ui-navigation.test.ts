import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const webRoot=path.resolve(process.cwd(),'../web');
const repoRoot=path.resolve(process.cwd(),'../..');
const pages=['dashboard.html','host-install.html','machines.html','listings.html','bookings.html','revenues.html'];

test('portal pages expose accessible navigation and real targets',async()=>{
  for(const page of pages){
    const html=await readFile(path.join(webRoot,page),'utf8');
    assert.match(html,/portal\.css/);
    assert.match(html,/portal\.js/);
    assert.doesNotMatch(html,/href=["']#["']/);
    assert.doesNotMatch(html,/javascript:/i);
  }
});

test('account pages render real API collections safely',async()=>{
  const listings=await readFile(path.join(webRoot,'listings.html'),'utf8');
  const bookings=await readFile(path.join(webRoot,'bookings.html'),'utf8');
  const portal=await readFile(path.join(webRoot,'portal.js'),'utf8');
  assert.match(listings,/data-listings/);
  assert.match(bookings,/data-bookings/);
  assert.match(portal,/async function listings\(\)/);
  assert.match(portal,/async function bookings\(\)/);
  assert.match(portal,/request\('\/dashboard'\)/);
  assert.match(portal,/escapeHTML/);
});

test('cross-origin GET requests remain simple and preserve error status',async()=>{
  for(const name of ['portal.js','publish.js']){
    const script=await readFile(path.join(webRoot,name),'utf8');
    assert.match(script,/headers=\{accept:'application\/json'/);
    assert.match(script,/options\.body!==undefined/);
    assert.doesNotMatch(script,/headers:\{'content-type':'application\/json'/);
  }
  const portal=await readFile(path.join(webRoot,'portal.js'),'utf8');
  assert.match(portal,/error\.status=response\.status/);
  assert.match(portal,/errorState\(/);
});

test('listing publication requires a machine linked by Host',async()=>{
  const html=await readFile(path.join(webRoot,'publish.html'),'utf8');
  const script=await readFile(path.join(webRoot,'publish.js'),'utf8');
  assert.match(html,/Machine reliée/);
  assert.match(html,/publishSubmit/);
  assert.doesNotMatch(html,/agentPublicKey/);
  assert.doesNotMatch(script,/api\('\/machines',\{method:'POST'/);
  assert.match(script,/api\('\/machines\/mine'\)/);
  assert.match(script,/state\?\.canPublish/);
  assert.match(script,/blockingReason/);
  assert.doesNotMatch(script,/option\.disabled=!m\.state\?\.canPublish/);
  assert.match(script,/Reliez d’abord une machine/);
});

test('installer downloads use direct GitHub release URLs',async()=>{
  const html=await readFile(path.join(webRoot,'host-install.html'),'utf8');
  const script=await readFile(path.join(webRoot,'host-downloads.js'),'utf8');
  assert.match(html,/host-downloads\.js/);
  assert.match(html,/Version portable de test/);
  assert.match(html,/GPUbnb-Host-Portable\.exe/);
  assert.match(html,/releases\/download\/host-test-latest\/gpubnb-host-windows-x64\.zip/);
  assert.match(html,/releases\/download\/host-test-latest\/gpubnb-host-linux-x64\.deb/);
  assert.match(html,/releases\/download\/host-test-latest\/gpubnb-host-macos-arm64\.dmg/);
  assert.doesNotMatch(html,/\.netlify\/functions\/host-download/);
  assert.doesNotMatch(script,/fetch\(/);
  assert.doesNotMatch(script,/\.netlify\/functions\/host-download/);
  assert.match(script,/Téléchargement direct depuis GitHub Releases/);

  const fn=await readFile(path.join(repoRoot,'netlify/functions/host-download.mjs'),'utf8');
  assert.match(fn,/host-test-latest/);
});

test('test release workflow publishes a verified Windows portable package',async()=>{
  const workflow=await readFile(path.join(repoRoot,'.github/workflows/publish-host-test-release.yml'),'utf8');
  assert.match(workflow,/workflow_dispatch/);
  assert.match(workflow,/push:/);
  assert.match(workflow,/branches:\s*\n\s*- main/);
  assert.match(workflow,/contents: write/);
  assert.match(workflow,/gpubnb-host-windows-x64\.exe/);
  assert.match(workflow,/gpubnb-host-windows-x64\.zip/);
  assert.match(workflow,/GPUbnb-Host-Portable\.exe/);
  assert.match(workflow,/missing MZ header/);
  assert.match(workflow,/unexpectedly small/);
  assert.match(workflow,/Compress-Archive/);
  assert.match(workflow,/gpubnb-host-linux-x64\.deb/);
  assert.match(workflow,/gpubnb-host-macos-arm64\.dmg/);
  assert.match(workflow,/gh release create host-test-latest/);
});

test('dashboard does not present mining as operational',async()=>{
  const html=await readFile(path.join(webRoot,'dashboard.html'),'utf8');
  assert.match(html,/Expérimental/);
  assert.match(html,/Minage/);
  assert.match(html,/Indisponible/);
});