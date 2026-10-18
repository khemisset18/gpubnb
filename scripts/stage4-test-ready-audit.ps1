#Requires -Version 5.1
# Read-only. Never executes, signs, installs or modifies inspected components.
[CmdletBinding()]
param(
    [string]$PackageDirectory,[string]$ManifestPath,[string]$ExpectedCommit,
    [string]$ExpectedManifestSha256,
    [string]$ExpectedPublisherSha256='200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a',
    [ValidateSet('unsigned','private-signed')][string]$SignatureStatus='private-signed',
    [switch]$InventoryOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$inventory=(& (Join-Path $PSScriptRoot 'stage4-pc1-inventory.ps1') -PublisherSha256 $ExpectedPublisherSha256 | Out-String)|ConvertFrom-Json
$packageVerified=$false
if(-not $InventoryOnly){
    if($ManifestPath -and [IO.Path]::GetFullPath($ManifestPath) -ine [IO.Path]::GetFullPath((Join-Path $PackageDirectory 'stage4.manifest.json'))){throw 'stage4_manifest_path_mismatch'}
    & (Join-Path $PSScriptRoot 'verify-stage4-package.ps1') -PackageDirectory $PackageDirectory `
        -ExpectedManifestSha256 $ExpectedManifestSha256 -ExpectedCommit $ExpectedCommit `
        -ExpectedPublisherSha256 $ExpectedPublisherSha256 -SignatureStatus $SignatureStatus | Out-Null
    if(-not $?){throw 'stage4_package_verification_failed'}
    $packageVerified=$true
}
[ordered]@{kind='STAGE4_TEST_READY_AUDIT';inventory=$inventory;packageVerified=$packageVerified;
    signatureStatus=if($packageVerified){$SignatureStatus}else{'not-checked'};
    hardwareQualified=$false;physicalTestPerformed=$false;installationPerformed=$false;
    physicalPreconditionsObserved=$inventory.preconditionsObserved} | ConvertTo-Json -Depth 16
if(-not $inventory.preconditionsObserved -or (-not $InventoryOnly -and -not $packageVerified)){exit 1}
