import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(apiRoot, '../..');

const read = (relativePath: string) => readFile(path.join(repoRoot, relativePath), 'utf8');

const WINDOWS_INSTALLER = 'gpubnb-host-windows-x64.exe';

test('website Host download uses the exact published Windows installer asset', async () => {
  const hostDownload = await read('netlify/functions/host-download.mjs');
  const publishWorkflow = await read('.github/workflows/publish-host-test-release.yml');

  assert.match(
    hostDownload,
    new RegExp(`windows: \\{ architecture: 'x64', filename: '${WINDOWS_INSTALLER.replaceAll('.', '\\.')}'`),
  );
  assert.match(publishWorkflow, new RegExp(`asset: ${WINDOWS_INSTALLER.replaceAll('.', '\\.')}`));
  assert.match(
    publishWorkflow,
    new RegExp(`verify-windows-release\\.ps1 -InstallerPath 'release-assets/${WINDOWS_INSTALLER.replaceAll('.', '\\.')}'`),
  );

  assert.doesNotMatch(hostDownload, /filename: 'gpubnb-host-windows-x64\.zip'/);
  assert.match(publishWorkflow, /gpubnb-host-windows-x64-portable\.zip/);
});

test('Host download metadata exposes the immutable release target for qualification', async () => {
  const hostDownload = await read('netlify/functions/host-download.mjs');
  assert.match(hostDownload, /immutableVersion: release\.target_commitish/);
  assert.match(hostDownload, /sha256: await checksumFor\(release, asset\.name\)/);
});
