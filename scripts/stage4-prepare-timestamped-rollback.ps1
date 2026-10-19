#Requires -Version 5.1
# Preparation of emergency recovery copies ONLY. Does not install, restore, stop
# services, change certificate stores, driver configuration or Windows policies.
# RFC3161 timestamping contacts an explicitly selected external TSA ONLY with
# -CreateTimestampedCopies. The normal invocation is read-only.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$BackupDirectory,
    [Parameter(Mandatory=$true)][string]$ExpectedBackupManifestSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedSignerSha256,
    [switch]$CreateTimestampedCopies,
    [string]$TimestampUrl,
    [string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
    throw 'stage4_rollback_windows_x64_required'
}
. (Join-Path $PSScriptRoot 'stage4-package-common.ps1')
foreach ($value in @($ExpectedBackupManifestSha256,$ExpectedSignerSha256)) {
    if ($value -cnotmatch '^[0-9a-f]{64}$' -or $value -match '^(.)\1{63}$') {
        throw 'stage4_rollback_external_sha256_required'
    }
}
if ($CreateTimestampedCopies) {
    if ([string]::IsNullOrWhiteSpace($TimestampUrl)) { throw 'stage4_rollback_tsa_url_required' }
    if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { throw 'stage4_rollback_output_required' }
    $uri = $null
    if (-not [Uri]::TryCreate($TimestampUrl,[UriKind]::Absolute,[ref]$uri) -or
        ($uri.Scheme -cne 'https' -and $uri.AbsoluteUri -cne 'http://timestamp.digicert.com/') -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Fragment) -or
        $uri.Host -notmatch '^[a-zA-Z0-9.-]+$') {
        throw 'stage4_rollback_approved_tsa_url_required'
    }
} elseif ($TimestampUrl -or $OutputDirectory) {
    throw 'stage4_rollback_create_switch_required'
}
$root = (Resolve-Path -LiteralPath $BackupDirectory -ErrorAction Stop).Path
$rootItem = Get-Item -LiteralPath $root -Force
if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'stage4_rollback_backup_link_forbidden'
}
$manifestPath = Join-Path $root 'backup.manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'stage4_rollback_manifest_missing'
}
if ((Get-Item -LiteralPath $manifestPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'stage4_rollback_manifest_link_forbidden'
}
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedBackupManifestSha256) {
    throw 'stage4_rollback_manifest_hash_mismatch'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or
    $manifest.kind -cne 'LOCAL_INSTALLED_COMPONENT_BACKUP' -or
    $manifest.installationPerformed -ne $false -or
    $manifest.privateKeyExported -ne $false -or
    $manifest.serviceModified -ne $false) {
    throw 'stage4_rollback_manifest_policy_mismatch'
}
$names = @('gpubnb-agent.exe','gpubnb-windows-stream.exe','gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
if (@($manifest.files).Count -ne 4) { throw 'stage4_rollback_exactly_four_files_required' }
$now = [DateTime]::UtcNow
$records = @()
foreach ($name in $names) {
    $items = @($manifest.files | Where-Object { $_.name -ceq $name })
    if ($items.Count -ne 1) { throw 'stage4_rollback_exactly_four_files_required' }
    $entry = $items[0]
    if ($entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $entry.signerSha256 -cne $ExpectedSignerSha256 -or
        $entry.architecture -cne 'AMD64' -or
        $entry.timestamped -ne $false -or
        $entry.signatureStatus -cne 'Valid') {
        throw ('stage4_rollback_backup_metadata_invalid:' + $name)
    }
    $path = Join-Path $root $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw ('stage4_rollback_component_missing:' + $name)
    }
    if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw ('stage4_rollback_component_link_forbidden:' + $name)
    }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) {
        throw ('stage4_rollback_component_hash_mismatch:' + $name)
    }
    $pe = Get-Stage4PeInfo -Path $path
    if ($pe.architecture -cne 'AMD64' -or -not $pe.certificateTablePresent) {
        throw ('stage4_rollback_component_pe_invalid:' + $name)
    }
    $sig = Get-AuthenticodeSignature -LiteralPath $path
    if ($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or
        $sig.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -cne $ExpectedSignerSha256 -or
        $null -ne $sig.TimeStamperCertificate) {
        throw ('stage4_rollback_signature_invalid:' + $name)
    }
    $expires = $sig.SignerCertificate.NotAfter.ToUniversalTime()
    if ($expires.ToString('o') -cne [string]$entry.signerExpiresUtc -or
        $sig.SignerCertificate.NotBefore.ToUniversalTime() -gt $now) {
        throw ('stage4_rollback_signer_dates_mismatch:' + $name)
    }
    $records += [ordered]@{name=$name;originalSha256=$entry.sha256;signerSha256=$ExpectedSignerSha256;signerExpiresUtc=$expires.ToString('o')}
}
$expiration = @($records | ForEach-Object { [DateTime]::Parse($_.signerExpiresUtc).ToUniversalTime() } | Sort-Object)[0]
$remainingHours = [Math]::Round(($expiration - $now).TotalHours,2)
if (-not $CreateTimestampedCopies) {
    [ordered]@{
        kind='STAGE4_ROLLBACK_TIMESTAMP_PREFLIGHT'
        ok=$true
        mode='read_only'
        originalBackupVerified=$true
        filesVerified=4
        remainingHours=$remainingHours
        originalSignerExpiresUtc=$expiration.ToString('o')
        previouslyTimestamped=$false
        durableRollbackEstablished=$false
        timestampedCopiesCreated=$false
        trustChanged=$false
        installationPerformed=$false
        serviceModified=$false
        externalTsaContacted=$false
    } | ConvertTo-Json -Depth 5
    return
}
# Hard deadline for new timestamps: never treat timestamps added at or after
# signer expiry as valid recovery evidence.
if ($expiration -le [DateTime]::UtcNow.AddMinutes(15)) {
    throw 'stage4_rollback_timestamp_deadline_too_close'
}
$output = Assert-Stage4NewOutput $OutputDirectory $root
$found = Get-Command signtool.exe -ErrorAction SilentlyContinue
$tool = if ($null -ne $found) { $found.Source } else { $null }
if (-not $tool) {
    $kits = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Windows Kits\10\bin'
    $tool = Get-ChildItem -LiteralPath $kits -Filter signtool.exe -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $tool) { throw 'stage4_rollback_signtool_required' }
[void][IO.Directory]::CreateDirectory($output)
$marker = Join-Path $output 'INCOMPLETE-DO-NOT-RESTORE.txt'
[IO.File]::WriteAllText($marker,'Timestamp evidence incomplete. Do not restore.')
$complete = $false
try {
    foreach ($r in $records) {
        $source = Join-Path $root $r.name
        $target = Join-Path $output $r.name
        Copy-Item -LiteralPath $source -Destination $target
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $r.originalSha256) {
            throw ('stage4_rollback_copy_hash_mismatch:' + $r.name)
        }
        & $tool timestamp /tr $uri.AbsoluteUri /td SHA256 /v $target | Out-Null
        if ($LASTEXITCODE -ne 0) { throw ('stage4_rollback_timestamp_failed:' + $r.name) }
        & $tool verify /pa /all /v $target | Out-Null
        if ($LASTEXITCODE -ne 0) { throw ('stage4_rollback_timestamp_verify_failed:' + $r.name) }
        $sig = Get-AuthenticodeSignature -LiteralPath $target
        if ($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or
            $sig.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -cne $ExpectedSignerSha256 -or
            $null -eq $sig.TimeStamperCertificate) {
            throw ('stage4_rollback_timestamp_not_valid:' + $r.name)
        }
        if ($sig.SignerCertificate.NotAfter.ToUniversalTime() -ne $expiration) {
            throw ('stage4_rollback_original_signer_changed:' + $r.name)
        }
        $r.timestampedSha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        $r.timestampAuthorityCertificateSha256 = $sig.TimeStamperCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
    }
    foreach ($r in $records) {
        if ((Get-FileHash -LiteralPath (Join-Path $root $r.name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $r.originalSha256) {
            throw ('stage4_rollback_original_backup_changed:' + $r.name)
        }
    }
    $report = [ordered]@{
        schemaVersion=1;kind='STAGE4_PRIVATE_ROLLBACK_TIMESTAMP_EVIDENCE'
        originalBackupManifestSha256=$ExpectedBackupManifestSha256
        originalSignerSha256=$ExpectedSignerSha256
        originalSignerExpiresUtc=$expiration.ToString('o')
        verifiedAtUtc=[DateTime]::UtcNow.ToString('o')
        timestampServiceHost=$uri.Host
        timestampVerifiedOnCurrentWindows=$true
        note='Not a guarantee of future service/WDAC/renter acceptance; verify in target context.'
        files=$records
        trustChanged=$false;serviceModified=$false;installationPerformed=$false
        readyToRestore=$false
    }
    $path = Join-Path $output 'rollback-timestamp-evidence.json'
    [IO.File]::WriteAllText($path,($report | ConvertTo-Json -Depth 8) + [Environment]::NewLine,[Text.UTF8Encoding]::new($false))
    Remove-Item -LiteralPath $marker
    $complete=$true
    [ordered]@{
        ok=$true
        kind=$report.kind
        outputDirectory=$output
        timestampedFilesVerified=4
        rollbackEvidenceSha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        originalSignerSha256=$ExpectedSignerSha256
        originalSignerExpiresUtc=$expiration.ToString('o')
        originalBackupUnchanged=$true
        installationPerformed=$false
        trustChanged=$false
        readyToRestore=$false
    } | ConvertTo-Json -Depth 5
} finally {
    if (-not $complete) { Write-Warning 'Timestamped rollback preparation incomplete; INCOMPLETE-DO-NOT-RESTORE.txt is retained.' }
}
