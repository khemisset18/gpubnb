import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

async function recoverySource(): Promise<string> {
  return readFile(path.join(repoRoot, 'e2e/recovery-agent-restart.cjs'), 'utf8');
}

test('agent-restart recovery cannot bypass the current GPU_PROOF-before-Developer contract', async () => {
  const source = await recoverySource();
  const compute = source.indexOf("workspaceSlug: 'compute'");
  const proof = source.indexOf("type: 'GPU_PROOF'");
  const developer = source.indexOf('/workspace/developer');

  assert.ok(compute >= 0, 'recovery must request Compute through the production route');
  assert.ok(proof > compute, 'recovery must wait for the real GPU_PROOF job');
  assert.ok(developer > proof, 'Developer preparation must happen only after GPU_PROOF');
  assert.match(source, /proofResult\.gpuDetected !== true/);
  assert.match(source, /proofResult\.metrics\?\.containerCleaned !== true/);
  assert.match(source, /bookingAfterProof\.status !== 'STARTING'/);
});

test('agent is killed only after genuine code-server traffic activated the booking', async () => {
  const source = await recoverySource();
  const management = source.indexOf("proveCodeServerChannel('Management'");
  const extensionHost = source.indexOf("proveCodeServerChannel('ExtensionHost'");
  const active = source.indexOf("current?.status === 'ACTIVE' && current.workspaceActivatedAt");
  const kill = source.indexOf("spawnSync('taskkill'");

  assert.ok(management >= 0 && extensionHost >= 0, 'both VS Code channels must carry upstream frames');
  assert.ok(active > management && active > extensionHost, 'ACTIVE must be observed after real upstream traffic');
  assert.ok(kill > active, 'the fault must be injected only after genuine activation');
  assert.match(source, /post-restart authenticated code-server traffic/);
  assert.match(source, /stillActive\.status !== 'ACTIVE'/);
});

test('recovery requires exact runtime adoption, clean COMPLETED termination, and four-resource cleanup', async () => {
  const source = await recoverySource();

  for (const required of [
    'gpubnb-dev-',
    'gpubnb-dev-proxy-',
    'gpubnb-workspace-',
    'gpubnb-workspace-internal-',
    "['ps', '-a', '--format', '{{.Names}}']",
    "['volume', 'ls', '--format', '{{.Name}}']",
    "['network', 'ls', '--format', '{{.Name}}']",
    'afterRestartSession.connectionMetadata?.runtimeId !== runtimeId',
    'liveAllocations.length !== 1',
    "current.status === 'COMPLETED'",
    'container, proxy, volume and network are all absent',
  ]) {
    assert.ok(source.includes(required), `recovery contract is missing: ${required}`);
  }

  assert.match(source, /\['FAILED', 'TIMED_OUT', 'CANCELLED'\]\.includes\(current\.status\)/);
  assert.doesNotMatch(source, /return \['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'\]\.includes/);
});

test('recovery proves a fresh heartbeat from the restarted Agent after normal completion', async () => {
  const shell = await readFile(path.join(repoRoot, 'e2e/recovery-agent-restart.sh'), 'utf8');
  const proof = await readFile(path.join(repoRoot, 'e2e/verify-recovery-heartbeat.cjs'), 'utf8');

  const scenario = shell.indexOf('node recovery-agent-restart.cjs setup');
  const heartbeatProof = shell.indexOf('node verify-recovery-heartbeat.cjs "$DATABASE_URL"');
  assert.ok(scenario >= 0 && heartbeatProof > scenario, 'fresh-heartbeat proof must run after the recovery scenario completes');

  for (const required of [
    "status: 'COMPLETED'",
    "machineWorkspace: { workspace: { slug: 'developer' } }",
    '!session.endedAt',
    "machine?.connectivity === 'ONLINE'",
    'machine.lastHeartbeatAt.getTime() > session.endedAt.getTime()',
    'Date.now() + 90_000',
    '[recovery-heartbeat-proof] PASS',
  ]) {
    assert.ok(proof.includes(required), `recovery heartbeat proof is missing: ${required}`);
  }
});
