import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../../../.github/workflows/publish-host-test-release.yml', import.meta.url);
const verifierUrl = new URL('../../../scripts/verify-windows-authenticode.ps1', import.meta.url);

test('Windows publication is wired to the Authenticode verifier before artifact publication', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const verifyIndex = workflow.indexOf('Verify Windows Authenticode publication policy');
  const uploadIndex = workflow.indexOf('actions/upload-artifact@v6', verifyIndex);
  assert.ok(verifyIndex >= 0, 'Windows publication must have an Authenticode policy step');
  assert.ok(uploadIndex > verifyIndex, 'Authenticode verification must happen before release artifact upload');

  assert.match(workflow, /GPUBNB_WINDOWS_SIGNING_REQUIRED:\s*\$\{\{\s*vars\.GPUBNB_WINDOWS_SIGNING_REQUIRED\s*\}\}/);
  assert.match(workflow, /verify-windows-authenticode\.ps1 -Path \$paths -Required/);
  assert.match(workflow, /verify-windows-authenticode\.ps1 -Path \$paths\s*\n/);
  assert.match(workflow, /release-assets\/gpubnb-host-windows-x64\.exe/);
  assert.match(workflow, /dist\/gpubnb-agent\.exe/);
  assert.match(workflow, /gpubnb-host-tunnel\.exe/);
  assert.match(workflow, /gpubnb-host-desktop\.exe/);
});

test('Authenticode verifier fails closed when required and rejects invalid present signatures', async () => {
  const source = await readFile(verifierUrl, 'utf8');
  assert.match(source, /\$Required -and -not \$signed/);
  assert.match(source, /authenticode_required_but_missing/);
  assert.match(source, /\$signed -and -not \$valid/);
  assert.match(source, /authenticode_present_but_invalid/);
  assert.match(source, /SignatureStatus\]::Valid/);
});
