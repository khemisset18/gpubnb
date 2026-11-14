#Requires -Version 5.1
# Read-only PC1 cutover evidence correlation. Never permits installation by itself.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ReadinessReportPath,
    [Parameter(Mandatory=$true)][string]$ExpectedReadinessReportSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedCandidateManifestSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedBackupManifestSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedCommit,
    [Parameter(Mandatory=$true)][string]$ExpectedMachineId,
    [Parameter(Mandatory=$true)][string]$ExpectedGpuUuid,
    [Parameter(Mandatory=$true)][string]$ObservedPrivateRenderCommit,
    [string]$RenterAccount='gpubnb-renter-qual'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'stage4-private-cutover-evidence-policy.ps1')

foreach($pin in @($ExpectedReadinessReportSha256,$ExpectedCandidateManifestSha256,$ExpectedBackupManifestSha256)) {
    if ($pin -cnotmatch '^[0-9a-fA-F]{64}$' -or $pin -match '^(.)\1{63}$') {
        throw 'stage4_cutover_external_sha256_required'
    }
}
if ($ExpectedCommit -cnotmatch '^[0-9a-f]{40}$' -or $ObservedPrivateRenderCommit -cnotmatch '^[0-9a-f]{40}$') {
    throw 'stage4_cutover_exact_commit_required'
}
$reportFile=Get-Item -LiteralPath $ReadinessReportPath -ErrorAction Stop
if ($reportFile.PSIsContainer -or ($reportFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    $reportFile.Length -gt 131072 -or $reportFile.Length -lt 8) {
    throw 'stage4_cutover_readiness_report_path_invalid'
}
if ((Get-FileHash -LiteralPath $reportFile.FullName -Algorithm SHA256).Hash -ine $ExpectedReadinessReportSha256) {
    throw 'stage4_cutover_readiness_report_hash_mismatch'
}
$report=Get-Content -LiteralPath $reportFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
[void](Assert-Stage4PrivateCutoverEvidence -Readiness $report -ExpectedCommit $ExpectedCommit -ExpectedCandidateManifestSha256 $ExpectedCandidateManifestSha256 -ExpectedBackupManifestSha256 $ExpectedBackupManifestSha256 -ExpectedMachineId $ExpectedMachineId -ExpectedGpuUuid $ExpectedGpuUuid -RenterAccount $RenterAccount)

# The observed Render SHA is a human-entered claim, NOT a signed release
# attestation. Even if it matches, this tool cannot authorize maintenance.
[ordered]@{
    kind='STAGE4_PC1_CUTOVER_EVIDENCE_CORRELATION'
    ok=$true
    reportHashVerified=$true
    localPreflightReportPassed=$true
    machineId=$ExpectedMachineId
    sourceCommit=$ExpectedCommit
    observedPrivateRenderCommit=$ObservedPrivateRenderCommit
    reportedBackendShaMatches=($ObservedPrivateRenderCommit -ceq $ExpectedCommit)
    backendReleaseIndependentlyAttested=$false
    localSystemActualRuntimeTested=$false
    rollbackDrillPassed=$false
    installationAuthorized=$false
    installationPerformed=$false
    quarantineModified=$false
    publicBookabilityEnabled=$false
    nextGate='independent_release_review_then_operator_present_physical_maintenance'
} | ConvertTo-Json -Depth 5
