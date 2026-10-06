import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptUrl = new URL('../../../scripts/build-windows-native-release-candidate.ps1', import.meta.url);

test('Stage 4 user-mode candidate build is ordered by signer trust and remains non-bookable', async () => {
  const source = await readFile(scriptUrl, 'utf8');

  assert.match(source, /LOCAL PHYSICAL TEST ONLY/);
  assert.match(source, /release_candidate_qualification_certificate_forbidden/);
  assert.match(source, /tracked_worktree_dirty/);
  assert.match(source, /index_dirty/);
  assert.match(source, /'--features', 'release-candidate'/);
  assert.doesNotMatch(source, /physical-qualification/);

  const mediaBuild = source.indexOf('STEP 1: Build and sign the media DLL');
  const mediaSign = source.indexOf('media Authenticode signing');
  const workerBuild = source.indexOf('STEP 2: Build the worker');
  const workerSign = source.indexOf('worker Authenticode signing');
  const helperBuild = source.indexOf('STEP 3: Build the distinct Stage 4 helper');
  const helperSign = source.indexOf('helper Authenticode signing');

  assert.ok(mediaBuild >= 0);
  assert.ok(mediaSign > mediaBuild);
  assert.ok(workerBuild > mediaSign);
  assert.ok(workerSign > workerBuild);
  assert.ok(helperBuild > workerSign);
  assert.ok(helperSign > helperBuild);

  assert.match(source, /GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256/);
  assert.match(source, /GPUBNB_WINDOWS_WORKER_SIGNER_SHA256/);
  assert.match(source, /GPUBNB_SOURCE_COMMIT/);
  assert.match(source, /mediaSignerSha256 -cne \$mediaSignerSha256/);
  assert.match(source, /worker_source_commit_mismatch/);
  assert.match(source, /release_candidate_user_mode_publisher_mismatch/);

  assert.match(source, /iddDriverProductionSigningRequired = \$true/);
  assert.match(source, /iddDriverIncluded = \$false/);
  assert.match(source, /publicBookabilityEnabled = \$false/);
  assert.match(source, /productionBookabilityChanged = \$false/);
});
