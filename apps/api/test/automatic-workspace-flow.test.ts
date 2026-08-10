import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compatibleWorkspaceChoices } from '../src/machine-workspace-catalog.js';

const apiRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webRoot=path.resolve(apiRoot,'../web');
const sourceRoot=path.resolve(apiRoot,'src');

test('a renter sees only executable workspaces compatible with the selected GPU',()=>{
  const choices=compatibleWorkspaceChoices({
    ramTotalMiB:12_064,
    diskTotalMiB:100_000,
    vramMiB:4_096,
    cudaVersion:'13.1',
    dockerAvailable:true,
    nvidiaRuntimeAvailable:true,
    operatingSystem:'Windows',
    virtualizationAvailable:false,
  });
  assert.deepEqual(choices.map(item=>item.slug),['developer','compute']);
  assert.ok(choices.every(item=>item.compatible));
  assert.ok(choices.every(item=>item.release==='BETA'));
});

test('incompatible workspaces are explained instead of being offered',()=>{
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
  assert.ok(choices.every(item=>!item.compatible));
  assert.ok(choices.every(item=>item.compatibility.missing.length>0));
});

test('marketplace routes the renter through GPU then workspace selection',async()=>{
  const marketplace=await readFile(path.join(webRoot,'app.js'),'utf8');
  const chooserHtml=await readFile(path.join(webRoot,'choose-workspace.html'),'utf8');
  const chooser=await readFile(path.join(webRoot,'choose-workspace.js'),'utf8');
  assert.match(marketplace,/choose-workspace\.html\?listing=/);
  assert.doesNotMatch(marketplace,/Réserver un Developer Workspace/);
  assert.match(chooserHtml,/Étape 2 sur 2/);
  assert.match(chooser,/workspaces\.filter\(workspace=>workspace\.compatible\)/);
  assert.match(chooser,/workspace\/developer/);
  assert.match(chooser,/workspace-sessions/);
  assert.match(chooser,/location\.href='bookings\.html'/);
});

test('server derives compatibility automatically without owner activation',async()=>{
  const server=await readFile(path.join(sourceRoot,'server.ts'),'utf8');
  const renterRoutes=await readFile(path.join(sourceRoot,'workspace-renter-routes.ts'),'utf8');
  assert.match(server,/listings\/:listingId\/workspaces/);
  assert.match(server,/ensureCompatibleMachineWorkspace\(db,booking\.listing\.machineId,'compute'\)/);
  assert.match(renterRoutes,/ensureCompatibleMachineWorkspace\(db,booking\.listing\.machineId,'developer'\)/);
  assert.doesNotMatch(renterRoutes,/machineId:booking\.listing\.machineId,enabledByOwner:true/);
});
