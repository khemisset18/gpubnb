#Requires -Version 5.1
# PC1 Stage 4 READ-ONLY cutover readiness. No installation or service mutation.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$CandidateDirectory,
    [Parameter(Mandatory=$true)][string]$ExpectedCandidateManifestSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedCommit,
    [Parameter(Mandatory=$true)][string]$ExpectedPublisherSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedMachineId,
    [Parameter(Mandatory=$true)][string]$ExpectedGpuUuid,
    [string]$RenterAccount='gpubnb-renter-qual',
    [Parameter(Mandatory=$true)][string]$BackupDirectory,
    [Parameter(Mandatory=$true)][string]$ExpectedBackupManifestSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$checks=[Collections.Generic.List[object]]::new()
function Report([string]$Name,[bool]$Passed,[string]$Detail) {
    $checks.Add([pscustomobject]@{name=$Name;passed=$Passed;detail=$Detail})
}
$names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe','gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
$installed='C:\Program Files\GPUbnb'
if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
    throw 'stage4_install_readiness_requires_windows_x64'
}
if ($ExpectedBackupManifestSha256 -cnotmatch '^[a-fA-F0-9]{64}$' -or
    $ExpectedCandidateManifestSha256 -cnotmatch '^[a-fA-F0-9]{64}$' -or
    $ExpectedCommit -cnotmatch '^[0-9a-f]{40}$' -or
    $ExpectedPublisherSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $ExpectedMachineId -cnotmatch '^c[a-z0-9]{15,40}$' -or
    $ExpectedGpuUuid -cnotmatch '^GPU-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') {
    throw 'stage4_install_readiness_external_pins_invalid'
}
. (Join-Path $PSScriptRoot 'stage4-package-common.ps1')
$pathsValid=$false
try {
    $pathPins=Assert-Stage4InstallPathsDisjoint -CandidateDirectory $CandidateDirectory `
        -BackupDirectory $BackupDirectory -InstalledDirectory $installed
    $candidate=$pathPins.candidate
    $backup=$pathPins.backup
    foreach ($dir in @($candidate,$backup)) {
        $d=Get-Item -LiteralPath $dir -Force -ErrorAction Stop
        if (-not $d.PSIsContainer -or ($d.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'stage4_install_readiness_directory_invalid'
        }
    }
    $pathsValid=$true
    Report 'nonoverlapping-real-folders' $true 'Candidate, backup and installed paths are distinct directories'
} catch {
    Report 'nonoverlapping-real-folders' $false $_.Exception.Message
}
if ($pathsValid) {
    try {
        $verifyArgs=@{
            PackageDirectory=$candidate
            ExpectedManifestSha256=$ExpectedCandidateManifestSha256
            ExpectedCommit=$ExpectedCommit
            ExpectedPublisherSha256=$ExpectedPublisherSha256
            ExpectedMachineId=$ExpectedMachineId
            ExpectedGpuUuid=$ExpectedGpuUuid
            RenterAccount=$RenterAccount
        }
        $res=(& (Join-Path $PSScriptRoot 'verify-stage4-private-qualification.ps1') @verifyArgs | Out-String) | ConvertFrom-Json
        if ($res.ok -cne $true -or $res.filesVerified -ne 4) {
            throw 'stage4_install_readiness_candidate_verifier_rejected'
        }
        Report 'new-package-complete-signed-pinned' $true 'Four exact signed components verified'
    } catch {
        Report 'new-package-complete-signed-pinned' $false $_.Exception.Message
    }
    try {
        $mp=Join-Path $backup 'backup.manifest.json'
        if ((Get-FileHash -LiteralPath $mp -Algorithm SHA256).Hash -ine $ExpectedBackupManifestSha256) {
            throw 'stage4_install_readiness_backup_manifest_hash_mismatch'
        }
        if (Test-Path -LiteralPath (Join-Path $backup 'INCOMPLETE-BACKUP.txt')) {
            throw 'stage4_install_readiness_incomplete_backup'
        }
        $manifest=Get-Content -LiteralPath $mp -Raw | ConvertFrom-Json
        if ($manifest.schemaVersion -ne 1 -or
            $manifest.kind -cne 'LOCAL_INSTALLED_COMPONENT_BACKUP' -or
            $manifest.sourceDirectory -ine $installed -or
            $manifest.configurationFilesChanged -cne $false -or
            $manifest.privateKeyExported -cne $false -or
            $manifest.serviceModified -cne $false -or
            $manifest.installationPerformed -cne $false -or
            @($manifest.files).Count -ne 4) {
            throw 'stage4_install_readiness_backup_policy_mismatch'
        }
        if ((Get-Acl -LiteralPath $installed).Sddl -cne $manifest.directorySddl) {
            throw 'stage4_install_readiness_installed_directory_acl_changed'
        }
        foreach ($name in $names) {
            $records=@($manifest.files | Where-Object { $_.name -ceq $name })
            if ($records.Count -ne 1) { throw "stage4_install_readiness_backup_component_missing:$name" }
            $r=$records[0]
            $saved=Join-Path $backup $name
            $live=Join-Path $installed $name
            if ($r.sha256 -cnotmatch '^[a-fA-F0-9]{64}$' -or
                (Get-FileHash -LiteralPath $saved -Algorithm SHA256).Hash -ine $r.sha256 -or
                (Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash -ine $r.sha256) {
                throw "stage4_install_readiness_backup_or_live_hash_mismatch:$name"
            }
            if ((Get-Acl -LiteralPath $live).Sddl -cne $r.sddl) {
                throw "stage4_install_readiness_live_acl_changed:$name"
            }
            foreach ($path in @($saved,$live)) {
                $sig=Get-AuthenticodeSignature -LiteralPath $path
                if ($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or
                    $sig.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256) -ine $r.signerSha256 -or
                    $sig.SignerCertificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow.AddHours(24)) {
                    throw "stage4_install_readiness_backup_signature_expired_or_invalid:$name"
                }
            }
        }
        Report 'old-backup-hashes-signatures-acls' $true 'Pinned old backup matches live files/ACLs; rollback eligibility at inspection time only'
    } catch {
        Report 'old-backup-hashes-signatures-acls' $false $_.Exception.Message
    }
    try {
        # Machine-context certificate trust is a proxy, NOT actual LocalSystem verification.
        $machineChain=[Security.Cryptography.X509Certificates.X509Chain]::new($true)
        try {
            $machineChain.ChainPolicy.RevocationMode=[Security.Cryptography.X509Certificates.X509RevocationMode]::Offline
            $machineChain.ChainPolicy.VerificationFlags=[Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
            [void]$machineChain.ChainPolicy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
            foreach ($name in $names) {
                $sig=Get-AuthenticodeSignature -LiteralPath (Join-Path $candidate $name)
                if ($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or
                    $sig.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256) -ine $ExpectedPublisherSha256 -or
                    -not $machineChain.Build($sig.SignerCertificate)) {
                    throw "stage4_install_readiness_machine_context_signer_untrusted:$name"
                }
            }
        } finally {
            $machineChain.Dispose()
        }
        Report 'machine-context-publisher-chain' $true 'Machine chain valid; actual LocalSystem trust still requires separate test'
    } catch {
        Report 'machine-context-publisher-chain' $false $_.Exception.Message
    }
}
try {
    $svc=Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'" -ErrorAction Stop
    if ($null -eq $svc -or $svc.State -ne 'Running' -or $svc.StartName -ine 'LocalSystem' -or
        $svc.ProcessId -eq 0 -or $svc.PathName -notmatch '(?i)gpubnb-agent\.exe') {
        throw 'stage4_install_readiness_service_identity_unexpected'
    }
    $agents=@(Get-CimInstance Win32_Process -Filter "Name='gpubnb-agent.exe'")
    if (@($agents | Where-Object { $_.ProcessId -eq $svc.ProcessId -and $_.SessionId -eq 0 }).Count -ne 1) {
        throw 'stage4_install_readiness_service_process_identity_unexpected'
    }
    foreach ($p in $agents) {
        if ([string]::IsNullOrWhiteSpace($p.ExecutablePath) -or
            (Split-Path -Parent $p.ExecutablePath) -ine $installed) {
            throw 'stage4_install_readiness_unexpected_agent_path'
        }
    }
    $native=@(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -in @('gpubnb-windows-stream.exe','gpubnb-windows-worker.exe')
    })
    if ($native.Count -ne 0) { throw 'stage4_install_readiness_active_helper_or_worker' }
    Report 'known-service-process-topology' $true 'LocalSystem service in session 0; no native Helper or Worker process'
} catch {
    Report 'known-service-process-topology' $false $_.Exception.Message
}
try {
    $gpus=@(& nvidia-smi '--query-gpu=uuid' '--format=csv,noheader' 2>$null)
    if ($LASTEXITCODE -ne 0 -or @($gpus | Where-Object { ([string]$_).Trim() -ieq $ExpectedGpuUuid }).Count -ne 1) {
        throw 'stage4_install_readiness_gpu_uuid_not_unique'
    }
    Report 'expected-gpu-uuid' $true 'Exact NVIDIA UUID present once; physical quiescence not proven'
} catch {
    Report 'expected-gpu-uuid' $false $_.Exception.Message
}
$pass=@($checks | Where-Object { -not $_.passed }).Count -eq 0
[ordered]@{
    kind='STAGE4_PC1_PRIVATE_INSTALL_READINESS_READONLY'
    machineId=$ExpectedMachineId
    gpuUuid=$ExpectedGpuUuid
    renterAccount=$RenterAccount
    candidateManifestSha256=$ExpectedCandidateManifestSha256.ToLowerInvariant()
    backupManifestSha256=$ExpectedBackupManifestSha256.ToLowerInvariant()
    sourceCommit=$ExpectedCommit
    localPreflightPassed=$pass
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
    checks=$checks.ToArray()
} | ConvertTo-Json -Depth 8
