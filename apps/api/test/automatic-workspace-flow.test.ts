import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compatibleWorkspaceChoices } from '../src/machine-workspace-catalog.js';

const apiRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webRoot=path.resolve(apiRoot,'../web');
const sourceRoot=path.resolve(apiRoot,'src');

const compatiblePrivateBetaMachine={
  ramTotalMiB:12_064,
  diskTotalMiB:100_000,
  vramMiB:4_096,
  cudaVersion:'13.1',
  dockerAvailable:true,
  nvidiaRuntimeAvailable:true,
  operatingSystem:'Windows',
  virtualizationAvailable:false,
};

test('private-beta marketplace exposes only the registered Compute workspace',()=>{
  const choices=compatibleWorkspaceChoices(compatiblePrivateBetaMachine);
  assert.deepEqual(choices.map(item=>item.slug),['compute']);
  assert.ok(choices.every(item=>item.compatible));
  assert.ok(choices.every(item=>item.release==='BETA'));
});

test('incompatible Compute workspace is explained instead of being offered as compatible',()=>{
  const choices=compatibleWorkspaceChoices({
    ramTotalMiB:2_048,
    diskTotalMiB:5_000,
    vramMiB:2_048,
    cudaVersion:null,
    dockerAvailable:false,
    nvidiaRuntimeAvailable:false,
    operatingSystem:'Windows',
    virtualizationAvailable:false,
  });
  assert.deepEqual(choices.map(item=>item.slug),['compute']);
  assert.ok(choices.every(item=>!item.compatible));
  assert.ok(choices.every(item=>item.compatibility.missing.length>0));
});

test('marketplace routes the renter through GPU then the registered Compute preparation route',async()=>{
  const marketplace=await readFile(path.join(webRoot,'app.js'),'utf8');
  const chooserHtml=await readFile(path.join(webRoot,'choose-workspace.html'),'utf8');
  const chooser=await readFile(path.join(webRoot,'choose-workspace.js'),'utf8');
  assert.match(marketplace,/choose-workspace\.html\?listing=/);
  assert.doesNotMatch(marketplace,/Réserver un Developer Workspace/);
  assert.match(chooserHtml,/Étape 2 sur 2/);
  assert.match(chooser,/workspaces\.filter\(workspace=>workspace\.compatible&&workspace\.slug==='compute'\)/);
  assert.match(chooser,/workspace\.slug!=='compute'/);
  assert.match(chooser,/workspace-sessions/);
  assert.match(chooser,/workspaceSlug:'compute'/);
  assert.doesNotMatch(chooser,/workspace\/developer/);
  assert.match(chooser,/location\.href='bookings\.html'/);
});

test('Compute server route creates GPU_PROOF through ensureComputePreparation',async()=>{
  const server=await readFile(path.join(sourceRoot,'server.ts'),'utf8');
  assert.match(server,/listings\/:listingId\/workspaces/);
  assert.match(server,/bookings\/:bookingId\/workspace-sessions/);
  assert.match(server,/ensureCompatibleMachineWorkspace\(db,booking\.listing\.machineId,'compute'\)/);
  assert.match(server,/type:JobType\.GPU_PROOF/);
  assert.match(server,/workspaceSlug:'compute'/);
});

test('bookings page follows GPU_PROOF, then offers the registered Developer workspace once it completes',async()=>{
  const bookings=await readFile(path.join(webRoot,'workspace-bookings.js'),'utf8');
  assert.match(bookings,/dashboard\.tenant\?\.jobs/);
  assert.match(bookings,/job\.type==='GPU_PROOF'/);
  assert.match(bookings,/data-prepare-compute/);
  assert.match(bookings,/workspace-sessions/);
  assert.match(bookings,/workspaceSlug:'compute'/);
  // The Developer workspace surface only ever activates for a booking whose
  // GPU_PROOF job already reached COMPLETED (see workspace-developer-flow.js);
  // it is never offered as an alternative to, or before, Compute/GPU_PROOF.
  assert.match(bookings,/job\.status==='COMPLETED'/);
  assert.match(bookings,/workspace\/developer/);
  assert.match(bookings,/workspace\/access/);
  assert.match(bookings,/data-create-developer/);
  assert.match(bookings,/data-open-developer/);
});

test('private-beta workspace browser scripts parse as valid JavaScript',()=>{
  for(const file of ['choose-workspace.js','workspace-bookings.js']){
    execFileSync(process.execPath,['--check',path.join(webRoot,file)],{stdio:'pipe'});
  }
});

test('Developer renter routes are registered (via device-authorization-routes) and reachable, but the marketplace still only lists Compute',async()=>{
  // registerWorkspaceRenterRoutes is not called directly from server.ts - it is
  // wired in indirectly through registerDeviceAuthorizationRoutes, which server.ts
  // does call. A plain string search on server.ts alone would miss that and wrongly
  // conclude the Developer routes are dormant; assert the real chain instead.
  const server=await readFile(path.join(sourceRoot,'server.ts'),'utf8');
  const deviceAuthRoutes=await readFile(path.join(sourceRoot,'device-authorization-routes.ts'),'utf8');
  const renterRoutes=await readFile(path.join(sourceRoot,'workspace-renter-routes.ts'),'utf8');
  assert.match(server,/registerDeviceAuthorizationRoutes\(app, ?db, ?redis\)/);
  assert.match(deviceAuthRoutes,/registerWorkspaceRenterRoutes\(app, ?db, ?redis\)/);
  assert.match(renterRoutes,/ensureCompatibleMachineWorkspace\(db,booking\.listing\.machineId,'developer'\)/);
  // The initial "choose a workspace for a new booking" marketplace still only
  // offers Compute: Developer is unlocked from bookings.html after GPU_PROOF
  // completes (see the test above), never chosen upfront alongside Compute.
  assert.deepEqual(compatibleWorkspaceChoices(compatiblePrivateBetaMachine).map(item=>item.slug),['compute']);
});
