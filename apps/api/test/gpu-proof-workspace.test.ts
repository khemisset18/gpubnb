import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(process.cwd(), '../..');

test('GPU Proof uses an immutable fixed CUDA workload', async () => {
  const dockerfile = await readFile(path.join(root, 'containers/gpu-proof-workspace/Dockerfile'), 'utf8');
  const source = await readFile(path.join(root, 'containers/gpu-proof-workspace/gpu_proof.cu'), 'utf8');
  assert.match(dockerfile, /FROM nvidia\/cuda:[^\s]+@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/gpu-proof"\]/);
  assert.match(source, /duration < 30 \|\| duration > 600/);
  assert.doesNotMatch(source, /system\s*\(|popen\s*\(|exec[lvpe]*\s*\(/);
});

test('rental execution has cancellation, signed metrics and verified cleanup gates', async () => {
  const server = await readFile(path.join(root, 'apps/api/src/server.ts'), 'utf8');
  const cli = await readFile(path.join(root, 'agent/gpubnb_agent/cli.py'), 'utf8');
  const runner = await readFile(path.join(root, 'agent/gpubnb_agent/runner.py'), 'utf8');
  assert.match(server, /\/agent\/jobs\/:id\/control/);
  assert.match(server, /signed_usage_proof_required/);
  assert.match(server, /containerCleaned/);
  assert.match(cli, /publish_sample/);
  assert.match(cli, /rental_cancel_requested/);
  assert.match(runner, /--network=none/);
  assert.match(runner, /--read-only/);
  assert.match(runner, /--cap-drop=ALL/);
  assert.match(runner, /gpu_proof_cleanup_unverified/);
});
