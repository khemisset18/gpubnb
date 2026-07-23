import test from 'node:test';import assert from 'node:assert/strict';
import { analyzeWorkspace } from '../src/workspace-compatibility.js';import { workspaceManifest } from '../src/workspace-manifests.js';
const capable={ramTotalMiB:65536,diskTotalMiB:2_000_000,vramMiB:24576,cudaVersion:'12.8',dockerAvailable:true,nvidiaRuntimeAvailable:true,operatingSystem:'Windows',virtualizationAvailable:true};
test('high-end machine receives an explainable AI score',()=>{const result=analyzeWorkspace(capable,workspaceManifest('ai')!);assert.equal(result.score,100);assert.equal(result.state,'READY');assert.ok(result.reasons.some(x=>x.includes('CUDA')))});
test('missing requirements produce explicit incompatibility',()=>{const result=analyzeWorkspace({...capable,ramTotalMiB:4096,vramMiB:2048,cudaVersion:null},workspaceManifest('ai')!);assert.equal(result.state,'INCOMPATIBLE');assert.ok(result.missing.length>=3)});
test('catalogue contains exactly thirteen unique workspaces',async()=>{const {workspaceManifests}=await import('../src/workspace-manifests.js');assert.equal(workspaceManifests.length,13);assert.equal(new Set(workspaceManifests.map(x=>x.slug)).size,13)});
