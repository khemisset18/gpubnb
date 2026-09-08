import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

async function read(relative: string): Promise<string> {
  return readFile(path.join(repoRoot, relative), 'utf8');
}

test('two-PC operator procedure describes the current real qualification path', async () => {
  const doc = await read('docs/TWO_PC_TEST.md');
  for (const required of [
    'qualification-preflight-pc-a.ps1',
    'qualification-preflight-pc-b.ps1',
    'qualification-evidence.ps1',
    'GPU_PROOF',
    'Ouvrir mon espace',
    'nvidia-smi --query-gpu=uuid,name',
    'code-server',
    'runtime-cleanliness',
    '-GpuProofEvidencePath',
    '-StateTimelinePath',
    '-FinalAvailabilityPath',
    'FAILED',
    'PASSED',
  ]) {
    assert.ok(doc.includes(required), `current two-PC procedure is missing: ${required}`);
  }
  assert.doesNotMatch(doc, /La tâche\s+`GPU_DIAGNOSTIC`\s+distante sera ajoutée/i);
  assert.doesNotMatch(doc, /Limites du test Phase 1/i);
  assert.match(doc, /Aucun raccourci localhost ne compte/);
});

test('PC A preflight locks release/Agent/GPU identity and is read-only toward Docker resources', async () => {
  const script = await read('scripts/qualification-preflight-pc-a.ps1');
  for (const required of [
    "'build-info'",
    'agentBuild.frozen',
    "'status'",
    'agentStatus.running',
    'agentStatus.machineId',
    "'runtime-check'",
    "'diagnose'",
    "'nvidia-smi'",
    'ExpectedGpuUuid',
    "'gpubnb-dev-*'",
    "'gpubnb-workspace-*'",
    "'gpubnb-workspace-internal-*'",
    'qualification-evidence',
    'repository is clean',
  ]) {
    assert.ok(script.includes(required), `PC A preflight is missing: ${required}`);
  }
  assert.doesNotMatch(script, /docker[^\n]*(?:\brm\b|volume\s+rm|network\s+rm)/i);
});

test('PC B preflight proves the configured public browser/API/gateway path and build identity', async () => {
  const script = await read('scripts/qualification-preflight-pc-b.ps1');
  for (const required of [
    'must use HTTPS for final physical qualification',
    '/api/ready',
    '/ready',
    '/ws-health',
    'gpubnb-ws-ok',
    'config.js',
    'GPUBNB_API_URL',
    'GPUBNB_GATEWAY_URL',
    'publishedCommit',
    'ExpectedReleaseCommit',
  ]) {
    assert.ok(script.includes(required), `PC B preflight is missing: ${required}`);
  }
});

test('evidence collector stays fail-closed and cannot self-declare physical qualification passed', async () => {
  const script = await read('scripts/qualification-evidence.ps1');
  for (const required of [
    "[ValidateSet('Start', 'Finish')]",
    'release-lock.json',
    'qualification-run.json',
    'PENDING_MANUAL_REVIEW',
    'EVIDENCE_COLLECTED',
    'Canonical-ResourceNames',
    'gpubnb-dev-proxy-',
    'gpubnb-workspace-internal-',
    'LeasedGpuUuid',
    'GpuProofJobId',
    'WorkspaceSessionId',
    'At least one sanitized CorrelationId is required',
    'PcBScreenshotPath is required for the renter nvidia-smi evidence',
    'GpuProofEvidencePath is required',
    'StateTimelinePath is required',
    'FinalAvailabilityPath is required',
    'Copy-SanitizedEvidence',
    'forbidden credential/token marker',
    'gpu-proof-evidence',
    'state-transition-timeline',
    'final-availability',
    'The collector never marks the release PASSED by itself',
  ]) {
    assert.ok(script.includes(required), `evidence collector is missing: ${required}`);
  }
  assert.doesNotMatch(script, /decision\s*=\s*['"]PASSED['"]/);
  assert.doesNotMatch(script, /status\s*=\s*['"]PASSED['"]/);
});

test('CI parses every physical qualification PowerShell helper before merge', async () => {
  const ci = await read('.github/workflows/ci.yml');
  for (const required of [
    'Validate qualification PowerShell syntax',
    'shell: pwsh',
    'System.Management.Automation.Language.Parser]::ParseFile',
    'scripts/qualification-preflight-pc-a.ps1',
    'scripts/qualification-preflight-pc-b.ps1',
    'scripts/qualification-evidence.ps1',
  ]) {
    assert.ok(ci.includes(required), `CI PowerShell syntax gate is missing: ${required}`);
  }
});

test('current gate advertises tooling but remains NOT YET PASSED and evidence bundles are gitignored', async () => {
  const current = await read('docs/CURRENT_PHYSICAL_QUALIFICATION.md');
  const ignore = await read('.gitignore');
  assert.match(current, /Status: \*\*NOT YET PASSED for the current release\*\*/);
  assert.match(current, /## Qualification tooling/);
  assert.match(current, /qualification-preflight-pc-a\.ps1/);
  assert.match(current, /qualification-preflight-pc-b\.ps1/);
  assert.match(current, /qualification-evidence\.ps1/);
  assert.match(current, /do \*\*not\*\* mark this gate PASSED/);
  assert.match(ignore, /^qualification-evidence\/$/m);
});
