import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.match(chooser,/workspaces\.filter\(workspace=>workspace\.compatible\)/);
  assert.match(chooser,/workspace-sessions/);
  assert.match(chooser,/workspaceSlug:'compute'/);
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

test('bookings page follows GPU_PROOF and never falls back to the unregistered Developer flow',async()=>{
  const bookings=await readFile(path.join(webRoot,'workspace-bookings.js'),'utf8');
  assert.match(bookings,/dashboard\.tenant\?\.jobs/);
  assert.match(bookings,/job\.type==='GPU_PROOF'/);
  assert.match(bookings,/data-prepare-compute/);
  assert.match(bookings,/workspace-sessions/);
  assert.match(bookings,/workspaceSlug:'compute'/);
  assert.doesNotMatch(bookings,/data-prepare-developer/);
  assert.doesNotMatch(bookings,/workspace\/developer/);
});

test('Developer remains internal until its renter route module is explicitly registered',async()=>{
  const server=await readFile(path.join(sourceRoot,'server.ts'),'utf8');
  const renterRoutes=await readFile(path.join(sourceRoot,'workspace-renter-routes.ts'),'utf8');
  assert.doesNotMatch(server,/registerWorkspaceRenterRoutes/);
  assert.match(renterRoutes,/ensureCompatibleMachineWorkspace\(db,booking\.listing\.machineId,'developer'\)/);
  assert.deepEqual(compatibleWorkspaceChoices(compatiblePrivateBetaMachine).map(item=>item.slug),['compute']);
});
