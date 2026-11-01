#Requires -Version 5.1
# Read-only independent verifier for NEW, scoped private installer candidates.
# Existing LOCAL_TEST_ONLY_NOT_RELEASE packages are expressly refused.
# No PE execution, service stop/start, install, certificate import or quarantine mutation.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PackageDirectory,
    [Parameter(Mandatory=$true)][string]$ExpectedManifestSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedCommit,
    [Parameter(Mandatory=$true)][string]$ExpectedPublisherSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedMachineId,
    [Parameter(Mandatory=$true)][string]$ExpectedGpuUuid,
    [Parameter(Mandatory=$true)][string]$RenterAccount
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
    throw 'private_qualification_windows_x64_required'
}
. (Join-Path $PSScriptRoot 'stage4-package-common.ps1')
. (Join-Path $PSScriptRoot 'stage4-private-qualification-policy.ps1')
if ($ExpectedManifestSha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'private_qualification_expected_manifest_invalid'
}
$root=(Resolve-Path -LiteralPath $PackageDirectory -ErrorAction Stop).Path
if (Test-Path -LiteralPath (Join-Path $root 'INCOMPLETE-DO-NOT-INSTALL.txt')) {
    throw 'private_qualification_incomplete_package'
}
$mp=Join-Path $root 'stage4-private-qualification.manifest.json'
if (-not (Test-Path -LiteralPath $mp -PathType Leaf) -or
    (Get-FileHash -LiteralPath $mp -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedManifestSha256) {
    throw 'private_qualification_manifest_hash_mismatch'
}
$manifest=Get-Content -LiteralPath $mp -Raw | ConvertFrom-Json
[void](Assert-Stage4PrivateQualificationPolicy -Manifest $manifest -ExpectedCommit $ExpectedCommit `
    -ExpectedPublisherSha256 $ExpectedPublisherSha256 -ExpectedMachineId $ExpectedMachineId `
    -ExpectedGpuUuid $ExpectedGpuUuid -ExpectedRenterAccount $RenterAccount)
$allowFiles=@(
    'stage4-private-qualification.manifest.json','unsigned-stage4.manifest.json',
    'build-identities.json','gpubnb-agent.exe','gpubnb-windows-stream.exe',
    'gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll'
)
foreach ($item in @(Get-Item -LiteralPath $root -Force)+@(Get-ChildItem -LiteralPath $root -Force -Recurse)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'private_qualification_reparse_point_forbidden'
    }
    if ($item.FullName -ne $root) {
        if ($item.PSIsContainer -or $item.Name -cnotin $allowFiles) {
            throw 'private_qualification_unexpected_payload'
        }
    }
}
$up=Join-Path $root 'unsigned-stage4.manifest.json'
if ((Get-FileHash -LiteralPath $up -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.sourceUnsignedManifestSha256) {
    throw 'private_qualification_unsigned_provenance_mismatch'
}
$unsigned=Get-Content -LiteralPath $up -Raw | ConvertFrom-Json
if ($unsigned.schemaVersion -ne 2 -or
    $unsigned.kind -cne 'STAGE4_UNSIGNED_PRIVATE_CANDIDATE' -or
    $unsigned.sourceCommit -cne $ExpectedCommit -or
    $unsigned.publisherSha256 -cne $ExpectedPublisherSha256 -or
    $unsigned.installable -cne $false -or
    $unsigned.publicBookabilityEnabled -cne $false -or
    $unsigned.iddDriverIncluded -cne $false -or
    $unsigned.buildIdentitiesSha256 -cne $manifest.buildIdentitiesSha256) {
    throw 'private_qualification_unsigned_source_policy_mismatch'
}
$ip=Join-Path $root 'build-identities.json'
if ((Get-FileHash -LiteralPath $ip -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.buildIdentitiesSha256) {
    throw 'private_qualification_build_identity_hash_mismatch'
}
$id=Get-Content -LiteralPath $ip -Raw | ConvertFrom-Json
[void](Assert-Stage4PrivateBuildIdentity -Identity $id -ExpectedCommit $ExpectedCommit `
    -ExpectedPublisherSha256 $ExpectedPublisherSha256)
if (@($unsigned.files).Count -ne 4) {
    throw 'private_qualification_unsigned_components_invalid'
}
foreach ($f in $manifest.files) {
    $record=@($unsigned.files | Where-Object { $_.name -ceq $f.name })
    if ($record.Count -ne 1 -or $record[0].sha256 -cne $f.unsignedSha256 -or
        $record[0].architecture -cne 'AMD64') {
        throw "private_qualification_unsigned_component_mismatch:$($f.name)"
    }
    $path=Join-Path $root $f.name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256) {
        throw "private_qualification_component_hash_mismatch:$($f.name)"
    }
    $pe=Get-Stage4PeInfo $path
    if ($pe.architecture -cne 'AMD64' -or -not $pe.certificateTablePresent -or
        (@($pe.imports) -join ',') -cne (@($record[0].imports) -join ',')) {
        throw "private_qualification_pe_metadata_mismatch:$($f.name)"
    }
    $sig=Get-AuthenticodeSignature -LiteralPath $path
    if ($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or
        $sig.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -cne $ExpectedPublisherSha256 -or
        $sig.SignerCertificate.Subject -notmatch 'LOCAL PHYSICAL TEST ONLY' -or
        $null -ne $sig.TimeStamperCertificate -or
        $sig.SignerCertificate.NotAfter.ToUniversalTime() -ne (Convert-Stage4ExpiryToUtc $manifest.expiresUtc)) {
        throw "private_qualification_authenticode_mismatch:$($f.name)"
    }
    Assert-Stage4Certificate -Certificate $sig.SignerCertificate -ExpectedPublisherSha256 $ExpectedPublisherSha256 `
        -MinimumValidityHours 24 -RequirePrivateKey $false
}
[ordered]@{ok=$true;kind='PRIVATE_QUALIFICATION_INSTALLER_CANDIDATE';filesVerified=4
    sourceCommit=$ExpectedCommit;machineId=$ExpectedMachineId;gpuUuid=$ExpectedGpuUuid
    manifestSha256=$ExpectedManifestSha256;authenticodeVerified=$true
    installationReviewRequired=$true;installationPerformed=$false;hardwareQualified=$false
    quarantineModified=$false;publicBookabilityEnabled=$false} | ConvertTo-Json
