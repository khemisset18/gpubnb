import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const webRoot=path.resolve(process.cwd(),'../web');
const repoRoot=path.resolve(process.cwd(),'../..');
const pages=['dashboard.html','host-install.html','machines.html','listings.html','bookings.html','revenues.html','mining.html'];

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
  assert.match(listings,/data-rental-listings/);
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

test('listing publication requires a server-qualified exact GPU linked by Host',async()=>{
  const html=await readFile(path.join(webRoot,'publish.html'),'utf8');
  const script=await readFile(path.join(webRoot,'publish.js'),'utf8');
  assert.match(html,/Machine reliée/);
  assert.match(html,/GPU à louer/);
  assert.match(html,/name="acceleratorId"/);
  assert.match(html,/publishSubmit/);
  assert.doesNotMatch(html,/agentPublicKey/);
  assert.doesNotMatch(script,/api\('\/machines',\{method:'POST'/);
  assert.match(script,/api\('\/rental\/machines\/manage'\)/);
  assert.match(script,/\/rental\/machines\/\$\{encodeURIComponent\(machineId\)\}\/gpus/);
  assert.match(script,/api\('\/rental\/listings'/);
  assert.match(script,/acceleratorId:gpuSelect\.value/);
  assert.match(script,/Reliez d’abord une machine/);
});

test('installer downloads are verified by the Netlify function',async()=>{
  const html=await readFile(path.join(webRoot,'host-install.html'),'utf8');
  const script=await readFile(path.join(webRoot,'host-downloads.js'),'utf8');
  assert.match(html,/host-downloads\.js/);
  assert.match(html,/gpubnb-host-windows-x64\.exe/);
  assert.match(html,/data-download-immutable/);
  assert.match(html,/data-download-instructions/);
  assert.match(html,/data-download-availability/);
  assert.doesNotMatch(html,/releases\/download\/host-test-latest/);
  assert.match(script,/\.netlify\/functions\/host-download/);
  assert.match(script,/AbortController/);
  assert.match(script,/immutable: metadata\.immutableVersion/);

  const fn=await readFile(path.join(repoRoot,'netlify/functions/host-download.mjs'),'utf8');
  assert.match(fn,/host-test-latest/);
  assert.match(fn,/gpubnb-host-windows-x64\.exe/);
  assert.match(fn,/SHA256SUMS\.txt/);
  assert.match(fn,/unsupported_platform/);
});
