#Requires -Version 5.1
# PRIVATE PHYSICAL QUALIFICATION ONLY. Never installs or modifies a service.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$UnsignedDirectory,
    [Parameter(Mandatory=$true)][string]$ExpectedManifestSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedCommit,
    [Parameter(Mandatory=$true)][string]$ExpectedPublisherSha256,
    [switch]$SignCopiesForPrivateTest,
    [string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) { throw 'stage4_private_windows_x64_required' }
. (Join-Path $PSScriptRoot 'stage4-package-common.ps1')
$root=(Resolve-Path -LiteralPath $UnsignedDirectory -ErrorAction Stop).Path
# External CI manifest hash, full commit and REAL public certificate pin are
# mandatory. Never derive expected values from an untrusted downloaded manifest.
$manifest=Read-Stage4Package $root $ExpectedManifestSha256 $ExpectedCommit $ExpectedPublisherSha256 'unsigned'
& (Join-Path $PSScriptRoot 'verify-stage4-package.ps1') -PackageDirectory $root `
    -ExpectedManifestSha256 $ExpectedManifestSha256 -ExpectedCommit $ExpectedCommit `
    -ExpectedPublisherSha256 $ExpectedPublisherSha256 | Out-Null
if(-not $?){throw 'stage4_private_unsigned_package_verification_failed'}
$matches=@(Get-ChildItem Cert:\CurrentUser\My | Where-Object {
    $_.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -ceq $ExpectedPublisherSha256
})
if($matches.Count -ne 1){throw 'stage4_private_test_certificate_unavailable'}
$cert=$matches[0]
Assert-Stage4Certificate $cert $ExpectedPublisherSha256
if(-not $SignCopiesForPrivateTest){
    [ordered]@{mode='read_only';ok=$true;sourceCommit=$ExpectedCommit;unsignedManifestSha256=$ExpectedManifestSha256;
        filesVerified=4;signingPerformed=$false;installationPerformed=$false;privateTestPinSha256=$ExpectedPublisherSha256;
        expiresUtc=$cert.NotAfter.ToUniversalTime().ToString('o');publicBookabilityEnabled=$false} | ConvertTo-Json
    return
}
$target=Assert-Stage4NewOutput $OutputDirectory $root
$found=Get-Command signtool.exe -ErrorAction SilentlyContinue
$signTool=if($null -ne $found){$found.Source}else{$null}
if(-not $signTool){
    $kits=Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Windows Kits\10\bin'
    $signTool=Get-ChildItem -LiteralPath $kits -Filter signtool.exe -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object {$_.FullName -match '\\x64\\signtool\.exe$'} | Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if(-not $signTool){throw 'stage4_private_signtool_required'}
# No timestamp: these copies expire with the local certificate. Never a public release.
[void][IO.Directory]::CreateDirectory($target)
$complete=$false
try {
    Copy-Item -LiteralPath (Join-Path $root 'build-identities.json') -Destination $target
    Copy-Item -LiteralPath (Join-Path $root 'stage4.manifest.json') -Destination (Join-Path $target 'unsigned-stage4.manifest.json')
    foreach($record in $manifest.files){
        # Rehash each source at the moment of copying, then verify the copy.
        $source=Join-Path $root $record.name;$copy=Join-Path $target $record.name
        if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.sha256){throw "stage4_private_unsigned_file_hash_mismatch:$($record.name)"}
        Copy-Item -LiteralPath $source -Destination $copy
        if((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.sha256){throw "stage4_private_copy_hash_mismatch:$($record.name)"}
        Assert-Stage4Certificate $cert $ExpectedPublisherSha256
        & $signTool sign /sha1 $cert.Thumbprint /fd SHA256 /v $copy | Out-Null
        if($LASTEXITCODE -ne 0){throw "stage4_private_sign_failed:$($record.name)"}
        $sig=Get-AuthenticodeSignature -LiteralPath $copy
        if($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or
            $sig.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -cne $ExpectedPublisherSha256){
            throw "stage4_private_signature_not_valid:$($record.name)"
        }
        $record | Add-Member -NotePropertyName unsignedSha256 -NotePropertyValue $record.sha256
        $record.sha256=(Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $manifest.kind='LOCAL_TEST_ONLY_NOT_RELEASE';$manifest.signatureStatus='private-signed'
    $manifest | Add-Member -NotePropertyName unsignedManifestSha256 -NotePropertyValue $ExpectedManifestSha256
    $manifest | Add-Member -NotePropertyName expiresUtc -NotePropertyValue $cert.NotAfter.ToUniversalTime().ToString('o')
    $manifest | Add-Member -NotePropertyName signedAtUtc -NotePropertyValue ([DateTime]::UtcNow.ToString('o'))
    $manifest | Add-Member -NotePropertyName timestamped -NotePropertyValue $false
    $manifest | Add-Member -NotePropertyName installationPerformed -NotePropertyValue $false
    [IO.File]::WriteAllText((Join-Path $target 'stage4.manifest.json'),($manifest|ConvertTo-Json -Depth 12)+"`n",[Text.UTF8Encoding]::new($false))
    $signedManifestHash=(Get-FileHash (Join-Path $target 'stage4.manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    & (Join-Path $PSScriptRoot 'verify-stage4-package.ps1') -PackageDirectory $target `
        -ExpectedManifestSha256 $signedManifestHash -ExpectedCommit $ExpectedCommit `
        -ExpectedPublisherSha256 $ExpectedPublisherSha256 -SignatureStatus private-signed | Out-Null
    if(-not $?){throw 'stage4_private_signed_package_verification_failed'}
    $sums=@($manifest.files|ForEach-Object {$_.sha256+'  '+$_.name})+@($signedManifestHash+'  stage4.manifest.json')
    [IO.File]::WriteAllText((Join-Path $target 'SHA256SUMS'),($sums -join "`n")+"`n",[Text.UTF8Encoding]::new($false))
    $complete=$true
    [ordered]@{ok=$true;kind='LOCAL_TEST_ONLY_NOT_RELEASE';sourceCommit=$ExpectedCommit;filesVerified=4;
        unsignedManifestSha256=$ExpectedManifestSha256;signedManifestSha256=$signedManifestHash;
        outputDirectory=$target;publisherSha256=$ExpectedPublisherSha256;installationPerformed=$false;
        publicBookabilityEnabled=$false} | ConvertTo-Json -Depth 6
} finally {
    # Deliberately keep failed staging for diagnosis. No broad recursive deletion.
    if(-not $complete){[IO.File]::WriteAllText((Join-Path $target 'INCOMPLETE-DO-NOT-INSTALL.txt'),'Signing failed. Never install this directory.')}
}
