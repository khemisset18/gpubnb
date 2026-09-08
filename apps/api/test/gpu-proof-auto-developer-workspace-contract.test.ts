import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repoRoot = new URL('../../../', import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, repoRoot), 'utf8');
}

test('verified GPU proof automatically analyzes and queues the persistent Developer workspace', async () => {
  const completion = await source('apps/api/src/gpu-proof-completion.ts');
  assert.match(completion, /ensureCompatibleMachineWorkspace\(db, machineId, 'developer'\)/);
  const compatibleBranch = completion.slice(completion.indexOf('if (developerWorkspaceCompatible)'));

  assert.match(compatibleBranch, /workspaceSession\.create\(/);
  assert.match(compatibleBranch, /status:\s*WorkspaceSessionStatus\.PREPARING/);
  assert.match(compatibleBranch, /type:\s*JobType\.WORKSPACE_PREPARE/);
  assert.match(compatibleBranch, /workspaceSlug:\s*'developer'/);
  assert.match(compatibleBranch, /GPU_PROOF_VERIFIED_AUTO_DEVELOPER/);
  assert.match(compatibleBranch, /DEVELOPER_PREPARATION_AUTO_REQUESTED_AFTER_GPU_PROOF/);
  assert.match(compatibleBranch, /developerPreparationQueued/);
  assert.match(compatibleBranch, /type:\s*JobType\.GPU_DIAGNOSTIC, status:\s*JobStatus\.QUEUED/);
  assert.match(compatibleBranch, /superseded_by_developer_workspace/);
});

test('legacy manual Developer request remains race-safe and returns the concurrent session', async () => {
  const routes = await source('apps/api/src/workspace-renter-routes.ts');
  const start = routes.indexOf("app.post('/bookings/:bookingId/workspace/developer'");
  const end = routes.indexOf("app.post('/bookings/:bookingId/workspace/retry'", start);
  const developerRoute = routes.slice(start, end);
  assert.match(developerRoute, /const existing=await db\.workspaceSession\.findFirst/);
  assert.match(developerRoute, /error instanceof Prisma\.PrismaClientKnownRequestError&&error\.code==='P2002'/);
  assert.match(developerRoute, /const raced=await db\.workspaceSession\.findFirst/);
  assert.match(developerRoute, /if\(raced\)return raced/);
});

test('the proof container is ephemeral but the renter Developer runtime is detached and not --rm', async () => {
  const runner = await source('agent/gpubnb_agent/runner.py');
  const gatewayV5 = await source('agent/gpubnb_agent/workspace_gateway_v5.py');

  const proofStart = runner.indexOf('def gpu_proof_command');
  const proofEnd = runner.indexOf('\ndef ', proofStart + 10);
  const proof = runner.slice(proofStart, proofEnd > proofStart ? proofEnd : undefined);
  assert.match(proof, /"run",\s*"--rm"/);

  const developerStart = gatewayV5.indexOf('def _launch_workspace_container');
  const developerEnd = gatewayV5.indexOf('\n    def ', developerStart + 10);
  const developer = gatewayV5.slice(developerStart, developerEnd > developerStart ? developerEnd : undefined);
  assert.match(developer, /"run",\s*"-d",\s*"--name",\s*container/);
  assert.doesNotMatch(developer, /"run",\s*"--rm"/);
  assert.match(developer, /"--entrypoint",\s*"code-server"/);
});

test('PC B labels GPU proof RUNNING as verification, not as an opened workspace', async () => {
  const bookings = await source('apps/web/workspace-bookings.js');
  assert.match(bookings, /Vérification GPU : \$\{escapeHTML\(job\.status\)\}/);
  assert.match(bookings, /Ouvrir mon espace/);
});
