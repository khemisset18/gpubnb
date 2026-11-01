#Requires -Version 5.1
# OFFLINE scratch-only restoration experiment. Never a service/installation script.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$CandidateDirectory,
    [Parameter(Mandatory=$true)][string]$ExpectedCandidateManifestSha256,
    [Parameter(Mandatory=$true)][string]$BackupDirectory,
    [Parameter(Mandatory=$true)][string]$ExpectedBackupManifestSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedCommit,
    [Parameter(Mandatory=$true)][string]$ExpectedPublisherSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedMachineId,
    [Parameter(Mandatory=$true)][string]$ExpectedGpuUuid,
    [string]$RenterAccount='gpubnb-renter-qual',
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
    throw 'stage4_offline_windows_x64_required'
}
. (Join-Path $PSScriptRoot 'stage4-private-offline-rollback-policy.ps1')
. (Join-Path $PSScriptRoot 'stage4-private-offline-acl.ps1')
$downloads=Join-Path $env:USERPROFILE 'Downloads'
[void](Assert-Stage4OfflineRollbackPaths -CandidateDirectory $CandidateDirectory -BackupDirectory $BackupDirectory -OutputDirectory $OutputDirectory -DownloadsDirectory $downloads)

# Re-run the complete read-only six-check audit with all independently pinned inputs.
$readinessArgs=@{
    CandidateDirectory=$CandidateDirectory
    ExpectedCandidateManifestSha256=$ExpectedCandidateManifestSha256
    ExpectedCommit=$ExpectedCommit
    ExpectedPublisherSha256=$ExpectedPublisherSha256
    ExpectedMachineId=$ExpectedMachineId
    ExpectedGpuUuid=$ExpectedGpuUuid
    RenterAccount=$RenterAccount
    BackupDirectory=$BackupDirectory
    ExpectedBackupManifestSha256=$ExpectedBackupManifestSha256
}
$readiness=(& (Join-Path $PSScriptRoot 'stage4-private-install-readiness.ps1') @readinessArgs | Out-String) | ConvertFrom-Json
if ($readiness.kind -cne 'STAGE4_PC1_PRIVATE_INSTALL_READINESS_READONLY' -or
    $readiness.localPreflightPassed -cne $true -or $readiness.installAuthorized -cne $false -or
    @($readiness.checks).Count -ne 6 -or
    @($readiness.checks | Where-Object { $_.passed -cne $true }).Count -ne 0) {
    throw 'stage4_offline_local_preflight_failed'
}
$original='C:\Program Files\GPUbnb'
$names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe','gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
$backupMp=Join-Path $BackupDirectory 'backup.manifest.json'
$candidateMp=Join-Path $CandidateDirectory 'stage4-private-qualification.manifest.json'
if ((Get-FileHash -LiteralPath $backupMp -Algorithm SHA256).Hash -ine $ExpectedBackupManifestSha256 -or
    (Get-FileHash -LiteralPath $candidateMp -Algorithm SHA256).Hash -ine $ExpectedCandidateManifestSha256) {
    throw 'stage4_offline_source_manifest_changed'
}
$backup=Get-Content -LiteralPath $backupMp -Raw | ConvertFrom-Json
$candidate=Get-Content -LiteralPath $candidateMp -Raw | ConvertFrom-Json
if ($backup.kind -cne 'LOCAL_INSTALLED_COMPONENT_BACKUP' -or
    $candidate.kind -cne 'GPUBNB_STAGE4_PRIVATE_QUALIFICATION_INSTALLER_CANDIDATE' -or
    @($backup.files).Count -ne 4 -or @($candidate.files).Count -ne 4) {
    throw 'stage4_offline_manifest_policy_invalid'
}
$root=[IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
$created=$false
$complete=$false
try {
    [void](New-Item -ItemType Directory -Path $root -ErrorAction Stop)
    $created=$true
    $scratch=Join-Path $root 'scratch-installed'
    [void](New-Item -ItemType Directory -Path $scratch -ErrorAction Stop)
    $verified=[Collections.Generic.List[object]]::new()
    # Build a scratch clone of the new candidate. All write targets are under $scratch.
    foreach ($name in $names) {
        $record=@($candidate.files | Where-Object { $_.name -ceq $name })
        if ($record.Count -ne 1) { throw "stage4_offline_missing_candidate:$name" }
        $source=Join-Path $CandidateDirectory $name
        $target=Join-Path $scratch $name
        $info=Get-Item -LiteralPath $source -Force -ErrorAction Stop
        if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ine $record[0].sha256) {
            throw "stage4_offline_candidate_changed:$name"
        }
        Copy-Item -LiteralPath $source -Destination $target -ErrorAction Stop
        $sig=Get-AuthenticodeSignature -LiteralPath $target
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $record[0].sha256 -or
            $sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or
            $sig.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256) -ine $ExpectedPublisherSha256) {
            throw "stage4_offline_candidate_copy_or_signature_invalid:$name"
        }
    }
    # Overlay ONLY scratch files with exact backed-up bytes and original file ACLs.
    foreach ($name in $names) {
        $record=@($backup.files | Where-Object { $_.name -ceq $name })
        if ($record.Count -ne 1) { throw "stage4_offline_missing_backup:$name" }
        $saved=Join-Path $BackupDirectory $name
        $live=Join-Path $original $name
        $target=Join-Path $scratch $name
        $info=Get-Item -LiteralPath $saved -Force -ErrorAction Stop
        if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            (Get-FileHash -LiteralPath $saved -Algorithm SHA256).Hash -ine $record[0].sha256 -or
            (Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash -ine $record[0].sha256) {
            throw "stage4_offline_backup_changed:$name"
        }
        $acl=Get-Acl -LiteralPath $live
        if ($acl.Sddl -cne $record[0].sddl) { throw "stage4_offline_live_acl_changed:$name" }
        Copy-Item -LiteralPath $saved -Destination $target -Force -ErrorAction Stop
        $snapshot=New-Stage4ScratchAclSnapshot -OriginalAcl $acl
        Set-Acl -LiteralPath $target -AclObject $snapshot -ErrorAction Stop
        $verified.Add([pscustomobject]@{name=$name;sha256=$record[0].sha256;scratchAclSnapshot=$snapshot;signer=$record[0].signerSha256})
    }
    # Reconstruct ONLY scratch directory ACL, never the installed directory.
    $directoryAcl=Get-Acl -LiteralPath $original
    if ($directoryAcl.Sddl -cne $backup.directorySddl) { throw 'stage4_offline_live_directory_acl_changed' }
    $directorySnapshot=New-Stage4ScratchAclSnapshot -OriginalAcl $directoryAcl -Directory
    Set-Acl -LiteralPath $scratch -AclObject $directorySnapshot -ErrorAction Stop
    [void](Assert-Stage4ScratchAclSnapshot -Expected $directorySnapshot -Observed (Get-Acl -LiteralPath $scratch) -Label 'scratch-directory')
    # Verify AGAIN after the directory ACL is applied (inheritance may change files).
    foreach ($record in $verified) {
        $path=Join-Path $scratch $record.name
        $sig=Get-AuthenticodeSignature -LiteralPath $path
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $record.sha256 -or
            $sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or
            $sig.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256) -ine $record.signer -or
            $sig.SignerCertificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow.AddHours(24)) {
            throw "stage4_offline_scratch_restore_verification_failed:$($record.name)"
        }
        [void](Assert-Stage4ScratchAclSnapshot -Expected $record.scratchAclSnapshot -Observed (Get-Acl -LiteralPath $path) -Label $record.name)
    }
    $report=[ordered]@{
        kind='STAGE4_PRIVATE_SCRATCH_ROLLBACK_RECONSTRUCTION'
        machineId=$ExpectedMachineId
        gpuUuid=$ExpectedGpuUuid
        sourceCommit=$ExpectedCommit
        candidateManifestSha256=$ExpectedCandidateManifestSha256.ToLowerInvariant()
        backupManifestSha256=$ExpectedBackupManifestSha256.ToLowerInvariant()
        scratchDirectory=$scratch
        scratchCandidateToOldBackupOverlayVerified=$true
        scratchFourFileHashesSignaturesAndPortableAclsVerified=$true
        scratchDirectoryPortableAclVerified=$true
        scratchAclMode='protected-explicit-snapshot-of-original-effective-aces'
        originalParentInheritanceReproduced=$false
        filesVerified=4
        installationAuthorized=$false
        installationPerformed=$false
        realServiceRollbackTested=$false
        backendReleaseIndependentlyAttested=$false
        localSystemActualRuntimeTested=$false
        physicalCleanupProven=$false
        quarantineModified=$false
        publicBookabilityEnabled=$false
    }
    $reportPath=Join-Path $root 'offline-rollback-rehearsal.report.json'
    [IO.File]::WriteAllText($reportPath,(ConvertTo-Json -InputObject $report -Depth 8)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
    $complete=$true
    $report | ConvertTo-Json -Depth 8
}
finally {
    if ($created -and -not $complete) {
        [IO.File]::WriteAllText((Join-Path $root 'INCOMPLETE-DO-NOT-USE.txt'),
            'Incomplete offline rehearsal. Scratch folder is never an install source.')
    }
}
