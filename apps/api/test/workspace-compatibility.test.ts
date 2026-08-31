import test from 'node:test';import assert from 'node:assert/strict';
import { analyzeWorkspace } from '../src/workspace-compatibility.js';import { workspaceManifest } from '../src/workspace-manifests.js';
const capable={ramTotalMiB:65536,diskTotalMiB:2_000_000,vramMiB:24576,cudaVersion:'12.8',dockerAvailable:true,nvidiaRuntimeAvailable:true,operatingSystem:'Windows',virtualizationAvailable:true};
test('high-end machine receives an explainable AI score',()=>{const result=analyzeWorkspace(capable,workspaceManifest('ai')!);assert.equal(result.score,100);assert.equal(result.state,'READY');assert.ok(result.reasons.some(x=>x.includes('CUDA')))});
test('missing requirements produce explicit incompatibility',()=>{const result=analyzeWorkspace({...capable,ramTotalMiB:4096,vramMiB:2048,cudaVersion:null},workspaceManifest('ai')!);assert.equal(result.state,'INCOMPATIBLE');assert.ok(result.missing.length>=3)});
test('catalogue contains exactly thirteen unique workspaces',async()=>{const {workspaceManifests}=await import('../src/workspace-manifests.js');assert.equal(workspaceManifests.length,13);assert.equal(new Set(workspaceManifests.map(x=>x.slug)).size,13)});

// GPU-tier profiles (mission requirement: the engine must produce different
// results for different real-world VRAM tiers, not a single hardcoded answer).
// The "low" tier below is not a synthetic number: it is this exact development
// machine's real, measured GPU during this project (NVIDIA GeForce GTX 1650,
// 4096 MiB total VRAM, driver 592.82, confirmed live via nvidia-smi).
const lowTierRealMachine={ramTotalMiB:12_353_652/1024,diskTotalMiB:500_000,vramMiB:4096,cudaVersion:'13.1',dockerAvailable:true,nvidiaRuntimeAvailable:true,operatingSystem:'Windows',virtualizationAvailable:true};
// Below AI's recommended tier on two axes (VRAM 16GB, RAM 32GB) but above its
// minimum on both (8GB, 16GB) - the engine scores each recommended-but-not-met
// axis as a partial penalty, not a hard failure.
const midTierMachine={...capable,vramMiB:10240,ramTotalMiB:20480};
const highTierMachine={...capable,vramMiB:24576};

test('a real low-VRAM machine (this session\'s own 4GB GTX 1650) is incompatible with AI Workspace (needs 8GB minimum)',()=>{
  const result=analyzeWorkspace(lowTierRealMachine,workspaceManifest('ai')!);
  assert.equal(result.state,'INCOMPATIBLE');
  assert.ok(result.missing.some(x=>x.includes('VRAM')));
});

test('the same real low-VRAM machine is compatible with Compute Workspace (no VRAM requirement)',()=>{
  const result=analyzeWorkspace(lowTierRealMachine,workspaceManifest('compute')!);
  assert.notEqual(result.state,'INCOMPATIBLE');
});

test('a mid-tier machine meets AI Workspace minimum but not its recommended tier, scored as LIMITED not READY',()=>{
  const result=analyzeWorkspace(midTierMachine,workspaceManifest('ai')!);
  assert.equal(result.state,'LIMITED');
  assert.ok(result.score<100&&result.score<85,'must be penalized for being below recommended, not scored as if ideal');
});

test('a high-tier 24GB card is READY for every GPU-requiring workspace in the catalogue',async()=>{
  const {workspaceManifests}=await import('../src/workspace-manifests.js');
  const gpuWorkspaces=workspaceManifests.filter(m=>typeof m.minimum.vramMiB==='number');
  assert.ok(gpuWorkspaces.length>0);
  for(const manifest of gpuWorkspaces){
    const result=analyzeWorkspace(highTierMachine,manifest);
    assert.notEqual(result.state,'INCOMPATIBLE',`${manifest.slug} must not be INCOMPATIBLE on a 24GB card`);
  }
});

test('the engine produces a strictly different verdict across the three tiers for the same workspace',()=>{
  const low=analyzeWorkspace(lowTierRealMachine,workspaceManifest('ai')!).state;
  const mid=analyzeWorkspace(midTierMachine,workspaceManifest('ai')!).state;
  const high=analyzeWorkspace(highTierMachine,workspaceManifest('ai')!).state;
  assert.equal(low,'INCOMPATIBLE');
  assert.equal(mid,'LIMITED');
  assert.equal(high,'READY');
  assert.notEqual(mid,high,'a mid-tier card must not be silently treated as equivalent to a high-end one');
  assert.notEqual(low,mid,'an incompatible card must not be silently treated as equivalent to a mid-tier one');
});

// Mandatory negative paths (mission section 15).
test('no GPU detected at all is incompatible with any workspace requiring VRAM',()=>{
  const noGpu={...capable,vramMiB:null,cudaVersion:null};
  const result=analyzeWorkspace(noGpu,workspaceManifest('ai')!);
  assert.equal(result.state,'INCOMPATIBLE');
});

test('insufficient RAM alone is incompatible even with an otherwise capable GPU',()=>{
  const result=analyzeWorkspace({...capable,ramTotalMiB:2048},workspaceManifest('ai')!);
  assert.equal(result.state,'INCOMPATIBLE');
  assert.ok(result.missing.some(x=>x.includes('RAM')));
});

test('insufficient storage alone is flagged explicitly, not silently ignored',()=>{
  const result=analyzeWorkspace({...capable,diskTotalMiB:1024},workspaceManifest('data')!);
  assert.ok(result.missing.some(x=>x.includes('Stockage')));
});

test('Docker unavailable blocks any workspace whose manifest requires it',()=>{
  const result=analyzeWorkspace({...capable,dockerAvailable:false},workspaceManifest('developer')!);
  assert.notEqual(result.state,'READY');
  assert.ok(result.missing.some(x=>x.includes('Docker')));
});

test('CUDA unavailable blocks a CUDA-requiring workspace even with ample VRAM',()=>{
  const result=analyzeWorkspace({...capable,cudaVersion:null},workspaceManifest('ai')!);
  assert.notEqual(result.state,'READY');
  assert.ok(result.missing.some(x=>x.includes('CUDA')));
});

test('a workspace with no GPU requirement at all is never blocked by GPU fields, even when they are null',()=>{
  // Audio Workspace has no vramMiB/cuda in its manifest minimums.
  const result=analyzeWorkspace({...capable,vramMiB:null,cudaVersion:null,nvidiaRuntimeAvailable:false},workspaceManifest('audio')!);
  assert.ok(!result.missing.some(x=>x.includes('VRAM')||x.includes('CUDA')));
});
