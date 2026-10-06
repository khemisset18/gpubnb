import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const harness = new URL('../../../scripts/windows-native-stage4-failure-qualification.ps1', import.meta.url);

test('Stage 4 Windows native physical fault harness is explicitly armed and narrowly scoped', async () => {
  const source = await readFile(harness, 'utf8');

  assert.match(source, /ValidateSet\('Preflight', 'HelperCrash', 'AgentRestart', 'NetworkInterruption', 'RebootPrepare', 'RebootVerify'\)/);
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
  assert.doesNotMatch(source, /shutdown\.exe/i);
});

test('Stage 4 helper and Agent faults accept only recovery or fail-closed local outcomes', async () => {
  const source = await readFile(harness, 'utf8');

  assert.match(source, /Observe-NativePostFaultOutcome/);
  assert.match(source, /outcome = 'recovered'/);
  assert.match(source, /outcome = 'fail_closed'/);
  assert.match(source, /overallAcceptancePendingServerEvidence = \$true/);
  assert.match(source, /staleReadyRejected = \$true/);

  assert.doesNotMatch(source, /displayRecreatedByFreshAuthority = \$true/);
  assert.doesNotMatch(source, /newAuthorityPid = \$recovered/);
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

test('network interruption is application-scoped and automatically rolled back', async () => {
  const source = await readFile(harness, 'utf8');

  assert.match(source, /gpubnb-host-tunnel\.exe/);
  assert.match(source, /New-NetFirewallRule/);
  assert.match(source, /-Direction Outbound/);
  assert.match(source, /-Action Block/);
  assert.match(source, /-Protocol TCP -RemotePort 443/);
  assert.match(source, /Start-FirewallRollbackWatchdog/);
  assert.match(source, /Remove-Stage4FirewallRules/);
  assert.match(source, /firewallRulesRemoved = \$true/);

  assert.doesNotMatch(source, /Set-NetFirewallProfile/i);
});

test('reboot qualification is prepare/verify only and never reboots the host itself', async () => {
  const source = await readFile(harness, 'utf8');

  assert.match(source, /manualRebootRequired = \$true/);
  assert.match(source, /automatedRebootCommandIssued = \$false/);
  assert.match(source, /Get-CimInstance Win32_OperatingSystem/);
  assert.match(source, /stage4_reboot_not_observed/);
  assert.match(source, /stage4_stale_authority_survived_reboot/);
  assert.match(source, /stage4_stale_session_ready_after_reboot/);
});

test('Stage 4 harness requires ready native authority before live faults and records sanitized evidence', async () => {
  const source = await readFile(harness, 'utf8');

  assert.match(source, /--status' '--json' '--session-id'/);
  assert.match(source, /stage4_helper_not_ready_before_fault/);
  assert.match(source, /schemaVersion = 2/);
  assert.match(source, /signerCertificateSha256/);
  assert.match(source, /finishedAt/);

  assert.doesNotMatch(source, /mediaToken\s*=/);
  assert.doesNotMatch(source, /renter_user_sid/i);
  assert.doesNotMatch(source, /provider_user_sid/i);
});
