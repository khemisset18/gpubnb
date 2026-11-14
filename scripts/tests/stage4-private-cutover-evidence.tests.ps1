#Requires -Version 5.1
# Synthetic, offline, read-only security policy tests; never touch Windows services.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$scripts=Split-Path -Parent $PSScriptRoot
$policy=Join-Path $scripts 'stage4-private-cutover-evidence-policy.ps1'
$entry=Join-Path $scripts 'stage4-private-cutover-evidence.ps1'
foreach ($path in @($policy,$entry)) {
    $tokens=$null;$errors=$null
    [void][Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
    if ($errors.Count -gt 0) { throw "cutover_parser_error:$($errors[0].Message)" }
    $source=Get-Content -LiteralPath $path -Raw
    if ($source -match '\b(?:Stop-Service|Start-Service|Restart-Service|Stop-Process|Remove-Item|Copy-Item|Move-Item|Set-Acl|Set-Service|Import-Certificate|Set-ItemProperty|Invoke-RestMethod|Invoke-WebRequest)\b') {
        throw 'cutover_unapproved_mutation_or_network'
    }
}
. $policy
$commit='32ffdc72ec7041310c4b07e286ac4c4c2818906c'
$machine='cmsiggruy0004df0tn669f6bn'
$gpu='GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a'
$candidate='abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd'
$backup='77095e5b23b2aa7b985e6c71b5ac8d36ed7ab987d39cd946aebc042996de44bd'
$names=@('nonoverlapping-real-folders','new-package-complete-signed-pinned','old-backup-hashes-signatures-acls',
    'machine-context-publisher-chain','known-service-process-topology','expected-gpu-uuid')
$script:baseline=[ordered]@{
    kind='STAGE4_PC1_PRIVATE_INSTALL_READINESS_READONLY'
    machineId=$machine;gpuUuid=$gpu;renterAccount='gpubnb-renter-qual'
    sourceCommit=$commit
    candidateManifestSha256=$candidate
    backupManifestSha256=$backup
    localPreflightPassed=$true
    installAuthorized=$false
    installationPerformed=$false
    serviceModified=$false
    certificateStoreModified=$false
    backendReleaseAligned=$false
    localSystemActualRuntimeTested=$false
    renterConsoleQualified=$false
    physicalCleanupProven=$false
    quarantineModified=$false
    publicBookabilityEnabled=$false
    checks=@($names | ForEach-Object { @{name=$_;passed=$true;detail='synthetic'} })
}
$expected=@{
    ExpectedCommit=$commit;ExpectedCandidateManifestSha256=$candidate
    ExpectedBackupManifestSha256=$backup;ExpectedMachineId=$machine
    ExpectedGpuUuid=$gpu;RenterAccount='gpubnb-renter-qual'
}
function Assert-Evidence($report) {
    Assert-Stage4PrivateCutoverEvidence -Readiness $report @expected
}
function Reject([string]$label,[scriptblock]$mutation) {
    $report=($script:baseline | ConvertTo-Json -Depth 15 | ConvertFrom-Json)
    & $mutation $report
    $rejected=$false
    try { [void](Assert-Evidence $report) } catch { $rejected=$true }
    if (-not $rejected) { throw "cutover_missing_rejection:$label" }
    Write-Host "PASS reject $label"
}
$good=($script:baseline | ConvertTo-Json -Depth 15 | ConvertFrom-Json)
if (-not (Assert-Evidence $good)) { throw 'cutover_positive_evidence_failed' }
Write-Host 'PASS exact six read-only readiness checks'
Reject 'other machine' {param($r)$r.machineId='c000000000000000'}
Reject 'other GPU' {param($r)$r.gpuUuid='GPU-00000000-0000-0000-0000-000000000000'}
Reject 'provider desktop identity' {param($r)$r.renterAccount='hicha'}
Reject 'wrong signed candidate pin' {param($r)$r.candidateManifestSha256=('1'*64)}
Reject 'wrong backup pin' {param($r)$r.backupManifestSha256=('2'*64)}
Reject 'wrong source commit' {param($r)$r.sourceCommit=('f'*40)}
Reject 'missing local preflight' {param($r)$r.localPreflightPassed=$false}
Reject 'self-authorized install' {param($r)$r.installAuthorized=$true}
Reject 'already performed install' {param($r)$r.installationPerformed=$true}
Reject 'service previously modified' {param($r)$r.serviceModified=$true}
Reject 'certificate store altered' {param($r)$r.certificateStoreModified=$true}
Reject 'backend falsely aligned' {param($r)$r.backendReleaseAligned=$true}
Reject 'local system falsely qualified' {param($r)$r.localSystemActualRuntimeTested=$true}
Reject 'renter console falsely qualified' {param($r)$r.renterConsoleQualified=$true}
Reject 'cleanup falsely proven' {param($r)$r.physicalCleanupProven=$true}
Reject 'quarantine cleared' {param($r)$r.quarantineModified=$true}
Reject 'public booking enabled' {param($r)$r.publicBookabilityEnabled=$true}
Reject 'failed one of six checks' {param($r)$r.checks[3].passed=$false}
Reject 'missing check' {param($r)$r.checks=@($r.checks[0..4])}
Reject 'duplicate check' {param($r)$r.checks[5].name=$r.checks[0].name}
Reject 'fabricated check' {param($r)$r.checks[5].name='fake-gpu-uuid'}
Reject 'unknown report kind' {param($r)$r.kind='APPROVED_INSTALLER'}
# Invalid independent pins fail before reading any filesystem path.
$rejected=$false
try {
    & $entry -ReadinessReportPath 'not-present' -ExpectedReadinessReportSha256 'bad' -ExpectedCandidateManifestSha256 $candidate -ExpectedBackupManifestSha256 $backup -ExpectedCommit $commit -ExpectedMachineId $machine -ExpectedGpuUuid $gpu -ObservedPrivateRenderCommit $commit | Out-Null
} catch {
    $rejected=$_.Exception.Message -like 'stage4_cutover_external_sha256_required*'
}
if (-not $rejected) { throw 'cutover_external_pin_not_required' }
Write-Host 'PASS external report pin required before file access'
Write-Host 'PASS all cutover evidence policy checks'
