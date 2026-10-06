import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const harness = new URL('../../../scripts/windows-native-stage4-failure-qualification.ps1', import.meta.url);

test('Stage 4 Windows native physical fault harness is explicitly armed and narrowly scoped', async () => {
  const source = await readFile(harness, 'utf8');

  assert.match(source, /ValidateSet\('Preflight', 'HelperCrash', 'AgentRestart'\)/);
  assert.match(source, /\[switch\]\$ArmFaults/);
  assert.match(source, /stage4_faults_not_armed/);

  assert.match(source, /Get-CimInstance Win32_Process -Filter "Name='gpubnb-windows-stream\.exe'"/);
  assert.match(source, /--authority-child/);
  assert.match(source, /--session-id/);
  assert.match(source, /StringComparison\]::OrdinalIgnoreCase/);
  assert.match(source, /Stop-Process -Id \$oldPid -Force/);

  assert.doesNotMatch(source, /taskkill[^\r\n]*\/IM/i);
  assert.doesNotMatch(source, /Stop-Process[^\r\n]*-Name/i);
  assert.doesNotMatch(source, /pnputil/i);
  assert.doesNotMatch(source, /Disable-NetAdapter/i);
  assert.doesNotMatch(source, /Restart-Computer/i);
});

test('Stage 4 harness proves signatures and uses SCM for Agent restart', async () => {
  const source = await readFile(harness, 'utf8');

  assert.match(source, /Get-AuthenticodeSignature/);
  assert.match(source, /SignatureStatus\]::Valid/);
  assert.match(source, /Get-FileHash[^\r\n]*SHA256/);

  assert.match(source, /Get-CimInstance Win32_Service/);
  assert.match(source, /gpubnb-agent\.exe/);
  assert.match(source, /Stop-Service -Name \$ServiceName/);
  assert.match(source, /Start-Service -Name \$ServiceName/);
  assert.match(source, /WaitForStatus/);
});

test('Stage 4 harness requires ready native authority before injecting a fault and records sanitized evidence', async () => {
  const source = await readFile(harness, 'utf8');

  assert.match(source, /--status' '--json' '--session-id'/);
  assert.match(source, /stage4_helper_not_ready_before_fault/);
  assert.match(source, /mediaReady -ne \$true/);
  assert.match(source, /schemaVersion = 1/);
  assert.match(source, /signerCertificateSha256/);
  assert.match(source, /finishedAt/);

  assert.doesNotMatch(source, /mediaToken\s*=/);
  assert.doesNotMatch(source, /renter_user_sid/i);
  assert.doesNotMatch(source, /provider_user_sid/i);
});
