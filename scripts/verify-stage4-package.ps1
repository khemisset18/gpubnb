#Requires -Version 5.1
# Read-only toward the package and machine. No session, install, signer or service changes.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PackageDirectory,
    [Parameter(Mandatory=$true)][string]$ExpectedManifestSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedCommit,
    [Parameter(Mandatory=$true)][string]$ExpectedPublisherSha256,
    [ValidateSet('unsigned','private-signed')][string]$SignatureStatus='unsigned',
    [switch]$ExecuteBuildIdentity
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) { throw 'stage4_windows_x64_required' }
$root=(Resolve-Path -LiteralPath $PackageDirectory -ErrorAction Stop).Path
. (Join-Path $PSScriptRoot 'stage4-package-common.ps1')
$manifest=Read-Stage4Package $root $ExpectedManifestSha256 $ExpectedCommit $ExpectedPublisherSha256 $SignatureStatus
foreach ($record in $manifest.files) {
    $file=Join-Path $root $record.name
    $sig=Get-AuthenticodeSignature -LiteralPath $file
    if ($SignatureStatus -ceq 'unsigned') {
        if ($sig.Status -ne 'NotSigned' -or $null -ne $sig.SignerCertificate) { throw "stage4_source_must_be_unsigned:$($record.name)" }
    } else {
        if ($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or
            $sig.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -cne $ExpectedPublisherSha256 -or
            $sig.SignerCertificate.NotAfter -le (Get-Date) -or $sig.SignerCertificate.NotBefore -gt (Get-Date) -or
            $sig.SignerCertificate.Subject -notmatch 'LOCAL PHYSICAL TEST ONLY') {
            throw "stage4_private_signature_not_valid:$($record.name)"
        }
        Assert-Stage4Certificate -Certificate $sig.SignerCertificate -ExpectedPublisherSha256 $ExpectedPublisherSha256 -MinimumValidityHours 0 -RequirePrivateKey $false
    }
    foreach ($dll in $record.imports) {
        if ($dll -match '^(api-ms-win-|ext-ms-win-)') { continue } # Windows API sets resolved by the loader.
        if (-not (Test-Path -LiteralPath (Join-Path ([Environment]::SystemDirectory) $dll) -PathType Leaf)) {
            throw "stage4_windows_dependency_missing:$($record.name):$dll"
        }
    }
}
if ($ExecuteBuildIdentity) {
    if ($env:GITHUB_ACTIONS -cne 'true') { throw 'stage4_identity_execution_ci_only' }
    $identity=Get-Content -LiteralPath (Join-Path $root 'build-identities.json') -Raw | ConvertFrom-Json
    $agent=(& (Join-Path $root 'gpubnb-agent.exe') build-info | Out-String) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $agent.frozen -ne $true -or $agent.buildCommit -cne $ExpectedCommit.Substring(0,12) -or $agent.agentVersion -cne $manifest.agentVersion) { throw 'stage4_agent_build_identity_mismatch' }
    foreach ($pair in @(@('helper','gpubnb-windows-stream.exe'),@('worker','gpubnb-windows-worker.exe'))) {
        $actual=(& (Join-Path $root $pair[1]) --build-policy --json | Out-String) | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw 'stage4_build_policy_failed' }
        foreach ($property in $identity.($pair[0]).PSObject.Properties) {
            if ($actual.($property.Name) -cne $property.Value) { throw "stage4_build_identity_mismatch:$($pair[0]):$($property.Name)" }
        }
    }
}
[ordered]@{ok=$true;filesVerified=4;sourceCommit=$ExpectedCommit;manifestSha256=$ExpectedManifestSha256;
    signatureStatus=$SignatureStatus;authenticodeVerified=($SignatureStatus -ceq 'private-signed');
    hardwareQualified=$false;installationPerformed=$false;publicBookabilityEnabled=$false} | ConvertTo-Json
