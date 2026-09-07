import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

for (const scriptName of ['run.sh', 'recovery-agent-restart.sh']) {
  test(`${scriptName} preserves pre-existing GPUbnb Docker resources during harness cleanup`, async () => {
    const source = await readFile(path.join(repoRoot, 'e2e', scriptName), 'utf8');

    for (const required of [
      'BASELINE_CONTAINERS="$(mktemp)"',
      'BASELINE_VOLUMES="$(mktemp)"',
      'BASELINE_NETWORKS="$(mktemp)"',
      'snapshot_gpu_workspace_resources',
      'remove_new_gpu_workspace_resources',
      "grep '^gpubnb-dev-'",
      "grep '^gpubnb-workspace-'",
      "grep '^gpubnb-workspace-internal-'",
      'grep -Fxq -- "$name" "$BASELINE_CONTAINERS"',
      'grep -Fxq -- "$name" "$BASELINE_VOLUMES"',
      'grep -Fxq -- "$name" "$BASELINE_NETWORKS"',
    ]) {
      assert.ok(source.includes(required), `${scriptName} is missing cleanup safety guard: ${required}`);
    }

    assert.doesNotMatch(source, /grep '\^gpubnb-dev-'\s*\|\s*xargs[^\n]*docker rm/);
    assert.doesNotMatch(source, /docker network (?:rm|remove)[^\n]*gpubnb-workspace-gateway/);

    const snapshot = source.indexOf('snapshot_gpu_workspace_resources\n');
    const trap = source.indexOf('trap cleanup EXIT');
    const harness = source.indexOf('echo "--- 1. disposable infrastructure ---"');
    assert.ok(snapshot >= 0 && snapshot < trap && trap < harness, `${scriptName} must snapshot before the harness creates resources`);
  });
}
