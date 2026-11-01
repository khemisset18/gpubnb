#Requires -Version 5.1
# Pure, read-only evidence contract. This is not an installation permit.
Set-StrictMode -Version Latest
function Assert-Stage4PrivateCutoverEvidence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$Readiness,
        [Parameter(Mandatory=$true)][string]$ExpectedCommit,
        [Parameter(Mandatory=$true)][string]$ExpectedCandidateManifestSha256,
        [Parameter(Mandatory=$true)][string]$ExpectedBackupManifestSha256,
        [Parameter(Mandatory=$true)][string]$ExpectedMachineId,
        [Parameter(Mandatory=$true)][string]$ExpectedGpuUuid,
        [Parameter(Mandatory=$true)][string]$RenterAccount
    )
    if ($ExpectedCommit -cnotmatch '^[a-f0-9]{40}$' -or
        $ExpectedCandidateManifestSha256 -cnotmatch '^[a-fA-F0-9]{64}$' -or
        $ExpectedBackupManifestSha256 -cnotmatch '^[a-fA-F0-9]{64}$' -or
        $ExpectedMachineId -cnotmatch '^c[a-z0-9]{15,40}$' -or
        $ExpectedGpuUuid -cnotmatch '^GPU-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or
        $RenterAccount -cnotmatch '^[A-Za-z0-9._-]{1,64}$') {
        throw 'stage4_cutover_invalid_expected_identity'
    }
    if ($null -eq $Readiness -or
        $Readiness.kind -cne 'STAGE4_PC1_PRIVATE_INSTALL_READINESS_READONLY' -or
        $Readiness.machineId -cne $ExpectedMachineId -or
        $Readiness.gpuUuid -cne $ExpectedGpuUuid -or
        $Readiness.renterAccount -cne $RenterAccount -or
        $Readiness.sourceCommit -cne $ExpectedCommit -or
        $Readiness.candidateManifestSha256 -ine $ExpectedCandidateManifestSha256 -or
        $Readiness.backupManifestSha256 -ine $ExpectedBackupManifestSha256 -or
        $Readiness.localPreflightPassed -cne $true -or
        $Readiness.installAuthorized -cne $false -or
        $Readiness.installationPerformed -cne $false -or
        $Readiness.serviceModified -cne $false -or
        $Readiness.certificateStoreModified -cne $false -or
        $Readiness.backendReleaseAligned -cne $false -or
        $Readiness.localSystemActualRuntimeTested -cne $false -or
        $Readiness.renterConsoleQualified -cne $false -or
        $Readiness.physicalCleanupProven -cne $false -or
        $Readiness.quarantineModified -cne $false -or
        $Readiness.publicBookabilityEnabled -cne $false) {
        throw 'stage4_cutover_readiness_evidence_invalid'
    }
    $required=@(
        'nonoverlapping-real-folders',
        'new-package-complete-signed-pinned',
        'old-backup-hashes-signatures-acls',
        'machine-context-publisher-chain',
        'known-service-process-topology',
        'expected-gpu-uuid'
    )
    $checks=@($Readiness.checks)
    if ($checks.Count -ne $required.Count) { throw 'stage4_cutover_missing_readiness_checks' }
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($check in $checks) {
        if ($null -eq $check -or $check.passed -cne $true -or
            $check.name -cnotin $required -or -not $seen.Add([string]$check.name)) {
            throw 'stage4_cutover_check_failed_or_duplicate'
        }
    }
    foreach ($name in $required) {
        if (-not $seen.Contains($name)) { throw "stage4_cutover_check_missing:$name" }
    }
    # A verified local report still requires independent operator authorization,
    # physical rollback exercise, actual LocalSystem execution and backend release.
    return $true
}
