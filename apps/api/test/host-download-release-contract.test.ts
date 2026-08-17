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
  const installPage = await read('apps/web/host-install.html');

  assert.match(
    hostDownload,
    new RegExp(`windows: \\{ architecture: 'x64', filename: '${WINDOWS_INSTALLER.replaceAll('.', '\\.')}'`),
  );
  assert.match(publishWorkflow, new RegExp(`asset: ${WINDOWS_INSTALLER.replaceAll('.', '\\.')}`));
  assert.match(
    publishWorkflow,
    new RegExp(`verify-windows-release\\.ps1 -InstallerPath 'release-assets/${WINDOWS_INSTALLER.replaceAll('.', '\\.')}'`),
  );
  assert.match(installPage, new RegExp(WINDOWS_INSTALLER.replaceAll('.', '\\.')));
  assert.match(installPage, /Installeur Windows/);

  assert.doesNotMatch(hostDownload, /filename: 'gpubnb-host-windows-x64\.zip'/);
  assert.doesNotMatch(installPage, /extrayez entièrement le ZIP/i);
  assert.doesNotMatch(installPage, /GPUbnb-Host-Portable\.exe/);
  assert.match(publishWorkflow, /gpubnb-host-windows-x64-portable\.zip/);
});

test('Host download visibly exposes immutable release identity and checksum', async () => {
  const hostDownload = await read('netlify/functions/host-download.mjs');
  const hostDownloadsUi = await read('apps/web/host-downloads.js');
  const installPage = await read('apps/web/host-install.html');

  assert.match(hostDownload, /immutableVersion: release\.target_commitish/);
  assert.match(hostDownload, /sha256: await checksumFor\(release, asset\.name\)/);
  assert.match(hostDownloadsUi, /immutable: metadata\.immutableVersion/);
  assert.match(installPage, /data-download-immutable/);
  assert.match(installPage, /data-download-checksum/);
});
