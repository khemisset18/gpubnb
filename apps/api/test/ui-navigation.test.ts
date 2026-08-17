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

test('OAuth callbacks stay on the current Netlify origin and preserve next',async()=>{
  const authConfig=await readFile(path.join(webRoot,'auth-config.js'),'utf8');
  const auth=await readFile(path.join(webRoot,'auth.js'),'utf8');
  assert.match(authConfig,/window\.location\.origin/);
  assert.doesNotMatch(authConfig,/https:\/\/gpubnb\.netlify\.app\/auth\.html/);
  assert.match(auth,/url\.origin!==location\.origin/);
  assert.match(auth,/url\.searchParams\.set\('next',safeNext\(\)\)/);
});

test('both supported Netlify base configurations publish the download function',async()=>{
  const rootConfig=await readFile(path.join(repoRoot,'netlify.toml'),'utf8');
  const webConfig=await readFile(path.join(webRoot,'netlify.toml'),'utf8');
  const buildScript=await readFile(path.join(repoRoot,'scripts/generate-web-build-info.mjs'),'utf8');
  assert.match(rootConfig,/functions\s*=\s*"netlify\/functions"/);
  assert.match(webConfig,/functions\s*=\s*"netlify\/functions"/);
  assert.match(buildScript,/CONTEXT === 'deploy-preview'/);
  assert.match(buildScript,/gpubnb-pr-\$\{reviewId\}\.onrender\.com/);
  assert.match(buildScript,/gpubnb\.onrender\.com/);
  assert.doesNotMatch(webConfig,/\[\[redirects\]\]/);
  const webFunction=await readFile(path.join(webRoot,'netlify/functions/host-download.mjs'),'utf8');
  assert.match(webFunction,/netlify\/functions\/host-download\.mjs/);
});

test('download helpers preserve instructions and detect platforms',async()=>{
  const script=await readFile(path.join(webRoot,'host-downloads.js'),'utf8');
  const context:any={Intl,URL,AbortController,setTimeout,clearTimeout};
  context.globalThis=context;
  vm.runInNewContext(script,context);
  const helpers=context.GPUBNB_HOST_DOWNLOADS;
  assert.equal(helpers.detectPlatform({platform:'Win32'}),'windows');
  assert.equal(helpers.detectPlatform({platform:'MacIntel'}),'macos');
  assert.equal(helpers.detectPlatform({userAgent:'X11; Linux x86_64'}),'linux');
  assert.equal(helpers.detectArchitecture({userAgent:'Windows Win64 x64'}),'x64');
  assert.equal(helpers.detectArchitecture({userAgent:'Macintosh Apple Silicon arm64'}),'arm64');
  assert.equal(helpers.formatBytes(1048576),'1 Mo');

  const instruction={textContent:'Instruction Windows spécifique'};
  const status={textContent:''};
  const button:any={textContent:'',href:'',removeAttribute(){},setAttribute(){},addEventListener(){}};
  const nodes:any={'[data-download-button]':button,'[data-download-availability]':status,'[data-download-instructions]':instruction};
  const card:any={dataset:{downloadPlatform:'windows'},querySelector:(selector:string)=>nodes[selector]||null};
  helpers.renderCard(card,{available:true,downloadUrl:'/download',version:'v1',size:1});
  assert.equal(instruction.textContent,'Instruction Windows spécifique');
  assert.equal(status.textContent,'Disponible');
});

test('test release workflow publishes an immutable candidate then promotes only after verification',async()=>{
  const workflow=await readFile(path.join(repoRoot,'.github/workflows/publish-host-test-release.yml'),'utf8');
  const verifier=await readFile(path.join(repoRoot,'.github/workflows/post-publish-host-windows-verify.yml'),'utf8');
  assert.match(workflow,/workflow_dispatch/);
  assert.match(workflow,/push:/);
  assert.match(workflow,/branches:\s*\n\s*- main/);
  assert.match(workflow,/contents: write/);
  assert.match(workflow,/gpubnb-host-windows-x64\.exe/);
  assert.match(workflow,/gpubnb-host-windows-x64-portable\.zip/);
  assert.match(workflow,/GPUbnb-Host-Portable\.exe/);
  // The real NSIS installer (Start Menu shortcut, elevated service install, uninstaller)
  // must actually reach the candidate: a prior version staged it and then deleted it.
  assert.doesNotMatch(workflow,/Remove-Item[^\n]*gpubnb-host-windows-x64\.exe/);
  assert.match(workflow,/test -s release-assets\/gpubnb-host-windows-x64\.exe/);
  assert.match(workflow,/pyinstaller .*--name gpubnb-agent/);
  assert.match(workflow,/tauri\.sidecar\.conf\.json/);
  assert.match(workflow,/Copy-Item 'dist\/gpubnb-agent\.exe'/);
  assert.match(workflow,/missing MZ header/);
  assert.match(workflow,/unexpectedly small/);
  assert.match(workflow,/Compress-Archive/);
  assert.match(workflow,/gpubnb-host-linux-x64\.deb/);
  assert.match(workflow,/gpubnb-host-macos-arm64\.dmg/);
  assert.match(workflow,/host-v0\.2\.0-beta\./);
  assert.match(workflow,/SHA256SUMS\.txt/);
  assert.match(workflow,/sha256sum --check/);
  assert.match(workflow,/Publish immutable test candidate/);
  assert.doesNotMatch(workflow,/gh release create host-test-latest/);

  // Promotion is intentionally separated onto a fresh runner and can happen only
  // after downloading the immutable candidate, checking every checksum and proving
  // the Windows installer/service lifecycle from those downloaded bytes.
  assert.match(verifier,/workflow_run/);
  assert.match(verifier,/publish-host-test-release/);
  assert.match(verifier,/gh release download/);
  assert.match(verifier,/SHA256SUMS\.txt/);
  assert.match(verifier,/Get-FileHash/);
  assert.match(verifier,/verify-windows-release\.ps1/);
  assert.match(verifier,/Install, exercise service, and uninstall downloaded Windows candidate/);
  assert.match(verifier,/Promote verified candidate to host-test-latest/);
  assert.match(verifier,/gh release create host-test-latest/);
});

test('dashboard presents mining as configurable but not production-ready',async()=>{
  const html=await readFile(path.join(webRoot,'dashboard.html'),'utf8');
  const portal=await readFile(path.join(webRoot,'portal.js'),'utf8');
  assert.match(html,/Expérimental sécurisé/);
  assert.match(html,/Minage/);
  assert.match(html,/href="mining\.html"/);
  assert.match(html,/désactivé par défaut/);
  assert.doesNotMatch(html,/Minage.*Fonctionnel/s);
  assert.match(portal,/Aucun rôle activé/);
  assert.match(portal,/machineReadiness/);
  assert.match(portal,/data-check="diagnostic"/);
  assert.match(portal,/Ce code expire dans/);
  assert.match(portal,/Math\.min\(Number\(data\.expiresIn\)\|\|0,600\)/);
  assert.match(portal,/privatePages/);
  assert.match(portal,/data-portal-logout/);
  assert.match(portal,/J’ai saisi le code dans GPUbnb Host/);
  assert.match(portal,/attempts\+\+>=60/);
  assert.match(portal,/clearInterval\(pairingPollTimer\)/);
  assert.match(portal,/publicationReadiness/);
});
