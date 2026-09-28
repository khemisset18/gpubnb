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

test('PC B preflight proves the configured public browser/API/gateway path and exact build identity', async () => {
  const script = await read('scripts/qualification-preflight-pc-b.ps1');
  for (const required of [
    'must use HTTPS for final physical qualification',
    '/api/ready',
    '/ready',
    '/api/release',
    '/release',
    'ClientWebSocket',
    'wss://',
    '/ws-health',
    'gpubnb-ws-ok',
    'directReleaseCommit',
    'sameOriginReleaseCommit',
    'config.js',
    'GPUBNB_API_URL',
    'GPUBNB_GATEWAY_URL',
    'publishedCommit',
    'ExpectedReleaseCommit',
  ]) {
    assert.ok(script.includes(required), `PC B preflight is missing: ${required}`);
  }
  assert.doesNotMatch(
    script,
    /Get-Public\s+"\$gateway\/ws-health"/,
    'gateway health is a WebSocket upgrade endpoint and must never regress to an HTTP GET probe',
  );
});

test('API publishes only an exact non-secret deployment commit for qualification', async () => {
  const routes = await read('apps/api/src/device-authorization-routes.ts');
  const identity = await read('apps/api/src/release-identity.ts');
  assert.match(routes, /app\.get\('\/release'/);
  assert.match(routes, /resolveReleaseIdentity\(\)/);
  assert.match(routes, /commit:\s*identity\.commit/);
  assert.match(identity, /GPUBNB_RELEASE_SHA/);
  assert.match(identity, /RENDER_GIT_COMMIT/);
  assert.match(identity, /GITHUB_SHA/);
  assert.match(identity, /\^\[0-9a-f\]\{40\}\$/i);
  assert.doesNotMatch(identity, /DATABASE_URL|REDIS_URL|SESSION_SECRET|TOKEN/);
});

test('PC B reserves the workspace tab synchronously before requesting the one-time access grant', async () => {
  const html = await read('apps/web/bookings.html');
  const guard = await read('apps/web/workspace-open-guard.js');
  assert.match(html, /workspace-open-guard\.js/);
  assert.match(guard, /document\.addEventListener\('click'/);
  assert.match(guard, /event\.stopPropagation\(\)/);
  assert.match(guard, /window\.open\('about:blank', '_blank'\)/);
  assert.match(guard, /reserved\.opener = null/);
  assert.match(guard, /reserved\.location\.replace\(destination\.href\)/);
  assert.match(guard, /workspace\/access/);
  assert.match(guard, /workspace\/developer|data-open-developer/);
  const reserve = guard.indexOf("window.open('about:blank', '_blank')");
  const grantFetch = guard.indexOf('await fetchAccess', reserve);
  assert.ok(reserve >= 0 && grantFetch > reserve, 'the blank tab must be reserved during the trusted click before any awaited network work');
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
    'This collector never marks the release PASSED by itself',
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

test('current gate preserves the beta.85 physical baseline while keeping the full deployment lock fail-closed', async () => {
  const current = await read('docs/CURRENT_PHYSICAL_QUALIFICATION.md');
  const baseline = await read('docs/PHYSICAL_BASELINE_2026-09-11_BETA85.md');
  const ignore = await read('.gitignore');

  assert.match(current, /HOST\/WORKSPACE PHYSICAL BASELINE PASSED/);
  assert.match(current, /full all-component release identity lock remains pending/);
  assert.match(current, /## Qualification tooling/);
  assert.match(current, /qualification-preflight-pc-a\.ps1/);
  assert.match(current, /qualification-preflight-pc-b\.ps1/);
  assert.match(current, /qualification-evidence\.ps1/);
  assert.match(current, /do \*\*not\*\* mark a release PASSED by themselves/);
  assert.match(current, /PHYSICAL_BASELINE_2026-09-11_BETA85\.md/);
  assert.match(baseline, /PHYSICALLY PASSED for the Host\/Workspace\/GPU\/cleanup path/);
  assert.match(baseline, /baseline\/physical-pass-beta85-2026-09-11/);
  assert.match(ignore, /^qualification-evidence\/$/m);
});
