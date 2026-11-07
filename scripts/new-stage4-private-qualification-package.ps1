#Requires -Version 5.1
# Creates a NEW, separately signed, machine/GPU-scoped PRIVATE qualification
# installer candidate from the externally verified UNSIGNED CI artifact.
# NEVER repackages the existing LOCAL_TEST_ONLY_NOT_RELEASE signed folder.
# NEVER installs, starts the Agent/Helper, modifies trust, or lifts quarantine.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$UnsignedDirectory,
    [Parameter(Mandatory=$true)][string]$ExpectedManifestSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedCommit,
    [Parameter(Mandatory=$true)][string]$ExpectedPublisherSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedMachineId,
    [Parameter(Mandatory=$true)][string]$ExpectedGpuUuid,
    [Parameter(Mandatory=$true)][string]$RenterAccount,
    [string]$OutputDirectory,
    [switch]$CreateInstallablePrivateQualificationPackage
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
    throw 'private_qualification_windows_x64_required'
}
. (Join-Path $PSScriptRoot 'stage4-package-common.ps1')
. (Join-Path $PSScriptRoot 'stage4-private-qualification-policy.ps1')
$root=(Resolve-Path -LiteralPath $UnsignedDirectory -ErrorAction Stop).Path
$unsigned=Read-Stage4Package $root $ExpectedManifestSha256 $ExpectedCommit $ExpectedPublisherSha256 'unsigned'
& (Join-Path $PSScriptRoot 'verify-stage4-package.ps1') -PackageDirectory $root `
    -ExpectedManifestSha256 $ExpectedManifestSha256 -ExpectedCommit $ExpectedCommit `
    -ExpectedPublisherSha256 $ExpectedPublisherSha256 | Out-Null
if (-not $?) { throw 'private_qualification_unsigned_verification_failed' }
# Fail closed on wrong scope BEFORE looking for a certificate or creating a folder.
$preflight=[pscustomobject]@{
    schemaVersion=1;kind='GPUBNB_STAGE4_PRIVATE_QUALIFICATION_INSTALLER_CANDIDATE'
    sourceKind='STAGE4_UNSIGNED_PRIVATE_CANDIDATE';sourceCommit=$ExpectedCommit
    publisherSha256=$ExpectedPublisherSha256;machineId=$ExpectedMachineId
    gpuUuid=$ExpectedGpuUuid;renterAccount=$RenterAccount
    privateQualificationOnly=$true;publicBookabilityEnabled=$false;iddDriverIncluded=$false
    installationPerformed=$false;installable=$true;installationReviewRequired=$true
    signatureStatus='private-signed';timestamped=$false;mutationAuthority='release-candidate'
    approvedUse='owner-present-local-private-qualification-only'
    sourceUnsignedManifestSha256=$ExpectedManifestSha256
    buildIdentitiesSha256=$unsigned.buildIdentitiesSha256
    protocols=$unsigned.protocols
    expiresUtc=[DateTime]::UtcNow.AddDays(2).ToString('o')
    files=@($unsigned.files | ForEach-Object {
        [pscustomobject]@{name=$_.name;sha256=('a'*64);unsignedSha256=$_.sha256;architecture='AMD64'}
    })
}
[void](Assert-Stage4PrivateQualificationPolicy -Manifest $preflight -ExpectedCommit $ExpectedCommit `
    -ExpectedPublisherSha256 $ExpectedPublisherSha256 -ExpectedMachineId $ExpectedMachineId `
    -ExpectedGpuUuid $ExpectedGpuUuid -ExpectedRenterAccount $RenterAccount)
$matches=@(Get-ChildItem Cert:\CurrentUser\My | Where-Object {
    $_.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -ceq $ExpectedPublisherSha256
})
if ($matches.Count -ne 1) { throw 'private_qualification_certificate_unavailable' }
$cert=$matches[0]
Assert-Stage4Certificate -Certificate $cert -ExpectedPublisherSha256 $ExpectedPublisherSha256
if (-not $CreateInstallablePrivateQualificationPackage) {
    [ordered]@{ok=$true;mode='read_only';sourceCommit=$ExpectedCommit;machineId=$ExpectedMachineId
        gpuUuid=$ExpectedGpuUuid;filesVerified=4;privateSignerReady=$true
        installationPerformed=$false;packageCreated=$false;publicBookabilityEnabled=$false} | ConvertTo-Json
    return
}
$target=Assert-Stage4NewOutput $OutputDirectory $root
$sign=Get-Command signtool.exe -ErrorAction SilentlyContinue
$signTool=if ($null -ne $sign) { $sign.Source } else { $null }
if (-not $signTool) {
    $kits=Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Windows Kits\10\bin'
    $signTool=Get-ChildItem -LiteralPath $kits -Filter signtool.exe -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signTool) { throw 'private_qualification_signtool_required' }
[void][IO.Directory]::CreateDirectory($target)
$complete=$false
try {
    Copy-Item -LiteralPath (Join-Path $root 'build-identities.json') -Destination $target
    Copy-Item -LiteralPath (Join-Path $root 'stage4.manifest.json') -Destination (Join-Path $target 'unsigned-stage4.manifest.json')
    $records=@()
    foreach ($entry in $unsigned.files) {
        $name=[string]$entry.name
        $src=Join-Path $root $name
        $dst=Join-Path $target $name
        if ((Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) {
            throw "private_qualification_source_changed:$name"
        }
        Copy-Item -LiteralPath $src -Destination $dst
        if ((Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) {
            throw "private_qualification_copy_changed:$name"
        }
        Assert-Stage4Certificate -Certificate $cert -ExpectedPublisherSha256 $ExpectedPublisherSha256
        & $signTool sign /s My /sha1 $cert.Thumbprint /fd SHA256 /v $dst | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "private_qualification_sign_failed:$name" }
        & $signTool verify /pa /all /v $dst | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "private_qualification_signature_verify_failed:$name" }
        $signature=Get-AuthenticodeSignature -LiteralPath $dst
        if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
            $signature.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -cne $ExpectedPublisherSha256 -or
            $null -ne $signature.TimeStamperCertificate) {
            throw "private_qualification_signature_wrong:$name"
        }
        $records+=@{name=$name;architecture='AMD64';unsignedSha256=$entry.sha256;
            sha256=(Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    $candidate=[pscustomobject]@{
        schemaVersion=1;kind='GPUBNB_STAGE4_PRIVATE_QUALIFICATION_INSTALLER_CANDIDATE'
        sourceKind='STAGE4_UNSIGNED_PRIVATE_CANDIDATE';sourceCommit=$ExpectedCommit
        publisherSha256=$ExpectedPublisherSha256;machineId=$ExpectedMachineId
        gpuUuid=$ExpectedGpuUuid;renterAccount=$RenterAccount
        privateQualificationOnly=$true;publicBookabilityEnabled=$false;iddDriverIncluded=$false
        installationPerformed=$false;installable=$true;installationReviewRequired=$true
        signatureStatus='private-signed';timestamped=$false;mutationAuthority='release-candidate'
        approvedUse='owner-present-local-private-qualification-only'
        sourceUnsignedManifestSha256=$ExpectedManifestSha256
        buildIdentitiesSha256=$unsigned.buildIdentitiesSha256
        protocols=$unsigned.protocols
        expiresUtc=$cert.NotAfter.ToUniversalTime().ToString('o')
        files=$records
    }
    [void](Assert-Stage4PrivateQualificationPolicy -Manifest $candidate -ExpectedCommit $ExpectedCommit `
        -ExpectedPublisherSha256 $ExpectedPublisherSha256 -ExpectedMachineId $ExpectedMachineId `
        -ExpectedGpuUuid $ExpectedGpuUuid -ExpectedRenterAccount $RenterAccount)
    $mp=Join-Path $target 'stage4-private-qualification.manifest.json'
    [IO.File]::WriteAllText($mp,($candidate | ConvertTo-Json -Depth 12)+"`n",[Text.UTF8Encoding]::new($false))
    $mh=(Get-FileHash -LiteralPath $mp -Algorithm SHA256).Hash.ToLowerInvariant()
    # Read-only independent verification before declaring a candidate complete.
    & (Join-Path $PSScriptRoot 'verify-stage4-private-qualification.ps1') `
        -PackageDirectory $target -ExpectedManifestSha256 $mh -ExpectedCommit $ExpectedCommit `
        -ExpectedPublisherSha256 $ExpectedPublisherSha256 -ExpectedMachineId $ExpectedMachineId `
        -ExpectedGpuUuid $ExpectedGpuUuid -RenterAccount $RenterAccount | Out-Null
    if (-not $?) { throw 'private_qualification_final_verify_failed' }
    $complete=$true
    [ordered]@{ok=$true;kind='PRIVATE_QUALIFICATION_INSTALLER_CANDIDATE';sourceCommit=$ExpectedCommit
        machineId=$ExpectedMachineId;gpuUuid=$ExpectedGpuUuid;filesVerified=4
        manifestSha256=$mh;outputDirectory=$target;installationReviewRequired=$true
        installationPerformed=$false;publicBookabilityEnabled=$false;expiresUtc=$candidate.expiresUtc} | ConvertTo-Json
} finally {
    if (-not $complete) {
        [IO.File]::WriteAllText((Join-Path $target 'INCOMPLETE-DO-NOT-INSTALL.txt'),
            'Private qualification packaging failed. This folder is never installable.')
    }
}
