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

test('installer page uses guarded direct download routes',async()=>{
  const html=await readFile(path.join(webRoot,'host-install.html'),'utf8');
  assert.match(html,/host-downloads\.js/);
  for(const platform of ['windows','linux','macos']){
    assert.match(html,new RegExp(`data-download-platform=["']${platform}["']`));
    assert.match(html,new RegExp(`host-download\\?platform=${platform}`));
  }
  assert.equal((html.match(/aria-disabled="true"/g)||[]).length,3);

  const fn=await readFile(path.join(repoRoot,'netlify/functions/host-download.mjs'),'utf8');
  assert.match(fn,/GPUBNB_HOST_WINDOWS_URL/);
  assert.match(fn,/GPUBNB_HOST_LINUX_URL/);
  assert.match(fn,/GPUBNB_HOST_MACOS_URL/);
  assert.match(fn,/url\.protocol === 'https:'/);
  assert.match(fn,/installer_not_configured/);
});

test('dashboard does not present mining as operational',async()=>{
  const html=await readFile(path.join(webRoot,'dashboard.html'),'utf8');
  assert.match(html,/Expérimental/);
  assert.match(html,/Minage/);
  assert.match(html,/Indisponible/);
});
