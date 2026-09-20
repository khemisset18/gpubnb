[CmdletBinding()]
param(
    [string]$WorkerPath = 'C:\Program Files\GPUbnb\gpubnb-windows-worker.exe',
    [string]$MediaDllPath = 'C:\Program Files\GPUbnb\GPUbnbWindowsMedia.dll',
    [switch]$Release
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-TrustedSignerSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "qualification_signed_component_missing:$Path"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "qualification_signed_component_invalid:$Path"
    }
    if ($null -eq $signature.SignerCertificate) {
        throw "qualification_signer_certificate_missing:$Path"
    }
    $sha256 = $signature.SignerCertificate.GetCertHashString(
        [System.Security.Cryptography.HashAlgorithmName]::SHA256
    ).ToLowerInvariant()
    if ($sha256 -notmatch '^[0-9a-f]{64}$' -or $sha256 -eq ('0' * 64)) {
        throw "qualification_signer_sha256_invalid:$Path"
    }
    return $sha256
}

if ($env:OS -ne 'Windows_NT') {
    throw 'qualification_build_windows_required'
}

$cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
if ($null -eq $cargo) {
    throw 'qualification_build_cargo_missing'
}
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($null -eq $git) {
    throw 'qualification_build_git_missing'
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..') -ErrorAction Stop).Path
$sourceCommit = (& $git.Source -C $repoRoot rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}
$mediaSigner = Get-TrustedSignerSha256 -Path $mediaDllPathResolved

$oldWorkerSigner = $env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256
$oldMediaSigner = $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256
try {
    $env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256 = $workerSigner
    $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256 = $mediaSigner

    $cargoArgs = @(
        'build',
        '--locked',
        '--manifest-path', (Join-Path $repoRoot 'native\windows-stream-helper\Cargo.toml'),
        '--features', 'physical-qualification',
        '--bin', 'gpubnb-windows-physical-qualify'
    )
    if ($Release) {
        $cargoArgs += '--release'
    }

    & $cargo.Source @cargoArgs
    if ($LASTEXITCODE -ne 0) {
        throw "qualification_harness_build_failed_$LASTEXITCODE"
    }
}
finally {
    $env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256 = $oldWorkerSigner
    $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256 = $oldMediaSigner
}

$profile = if ($Release) { 'release' } else { 'debug' }
$harness = Join-Path $repoRoot "native\windows-stream-helper\target\$profile\gpubnb-windows-physical-qualify.exe"
$resolved = (Resolve-Path -LiteralPath $harness -ErrorAction Stop).Path
$harnessSha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
$workerSha256 = (Get-FileHash -LiteralPath $workerPathResolved -Algorithm SHA256).Hash.ToLowerInvariant()
$mediaDllSha256 = (Get-FileHash -LiteralPath $mediaDllPathResolved -Algorithm SHA256).Hash.ToLowerInvariant()
$manifestPath = [IO.Path]::ChangeExtension($resolved, '.manifest.json')

$manifest = [ordered]@{
    schemaVersion = 1
    sourceCommit = $sourceCommit
    harnessSha256 = $harnessSha256
    workerSha256 = $workerSha256
    mediaDllSha256 = $mediaDllSha256
    workerSignerCertificateSha256 = $workerSigner
    mediaSignerCertificateSha256 = $mediaSigner
    physicalQualificationFeature = $true
    productionBookabilityChanged = $false
}
[IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 4) + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false)
)

[ordered]@{
    ok = $true
    sourceCommit = $sourceCommit
    harnessPath = $resolved
    harnessSha256 = $harnessSha256
    manifestPath = $manifestPath
    workerSignerCertificateSha256 = $workerSigner
    mediaSignerCertificateSha256 = $mediaSigner
    productionBookabilityChanged = $false
} | ConvertTo-Json -Depth 4
) {
    throw 'qualification_build_source_commit_unavailable'
}
& $git.Source -C $repoRoot diff --quiet --
if ($LASTEXITCODE -ne 0) {
    throw 'qualification_build_tracked_worktree_dirty'
}
& $git.Source -C $repoRoot diff --cached --quiet --
if ($LASTEXITCODE -ne 0) {
    throw 'qualification_build_index_dirty'
}

$workerPathResolved = (Resolve-Path -LiteralPath $WorkerPath -ErrorAction Stop).Path
$mediaDllPathResolved = (Resolve-Path -LiteralPath $MediaDllPath -ErrorAction Stop).Path
$workerSigner = Get-TrustedSignerSha256 -Path $workerPathResolved
$mediaSigner = Get-TrustedSignerSha256 -Path $MediaDllPath

$oldWorkerSigner = $env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256
$oldMediaSigner = $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256
try {
    $env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256 = $workerSigner
    $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256 = $mediaSigner

    $cargoArgs = @(
        'build',
        '--locked',
        '--manifest-path', 'native/windows-stream-helper/Cargo.toml',
        '--features', 'physical-qualification',
        '--bin', 'gpubnb-windows-physical-qualify'
    )
    if ($Release) {
        $cargoArgs += '--release'
    }

    & $cargo.Source @cargoArgs
    if ($LASTEXITCODE -ne 0) {
        throw "qualification_harness_build_failed_$LASTEXITCODE"
    }
}
finally {
    $env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256 = $oldWorkerSigner
    $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256 = $oldMediaSigner
}

$profile = if ($Release) { 'release' } else { 'debug' }
$harness = Join-Path $PSScriptRoot "..\..\native\windows-stream-helper\target\$profile\gpubnb-windows-physical-qualify.exe"
$resolved = (Resolve-Path -LiteralPath $harness -ErrorAction Stop).Path

[ordered]@{
    ok = $true
    harnessPath = $resolved
    harnessSha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
    workerSignerCertificateSha256 = $workerSigner
    mediaSignerCertificateSha256 = $mediaSigner
    productionBookabilityChanged = $false
} | ConvertTo-Json -Depth 4
