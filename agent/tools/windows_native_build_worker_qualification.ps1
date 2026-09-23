[CmdletBinding()]
param(
    [string]$MediaDllPath = 'C:\Program Files\GPUbnb\GPUbnbWindowsMedia.dll',
    [switch]$Release
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'qualification_worker_build_windows_required'
}

$cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
if ($null -eq $cargo) {
    throw 'qualification_worker_build_cargo_missing'
}
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($null -eq $git) {
    throw 'qualification_worker_build_git_missing'
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..') -ErrorAction Stop).Path
$sourceCommit = (& $git.Source -C $repoRoot rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'qualification_worker_source_commit_unavailable'
}
& $git.Source -C $repoRoot diff --quiet --
if ($LASTEXITCODE -ne 0) {
    throw 'qualification_worker_tracked_worktree_dirty'
}
& $git.Source -C $repoRoot diff --cached --quiet --
if ($LASTEXITCODE -ne 0) {
    throw 'qualification_worker_index_dirty'
}

$mediaDll = (Resolve-Path -LiteralPath $MediaDllPath -ErrorAction Stop).Path
$signature = Get-AuthenticodeSignature -LiteralPath $mediaDll
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw 'qualification_worker_media_signature_invalid'
}
if ($null -eq $signature.SignerCertificate) {
    throw 'qualification_worker_media_signer_missing'
}
$mediaSigner = $signature.SignerCertificate.GetCertHashString(
    [System.Security.Cryptography.HashAlgorithmName]::SHA256
).ToLowerInvariant()
if ($mediaSigner -notmatch '^[0-9a-f]{64}$' -or $mediaSigner -eq ('0' * 64)) {
    throw 'qualification_worker_media_signer_invalid'
}

$oldMediaSigner = $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256
$oldSourceCommit = $env:GPUBNB_SOURCE_COMMIT
try {
    $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256 = $mediaSigner
    $env:GPUBNB_SOURCE_COMMIT = $sourceCommit

    $cargoArgs = @(
        'build',
        '--locked',
        '--manifest-path', (Join-Path $repoRoot 'native\windows-worker\Cargo.toml')
    )
    if ($Release) {
        $cargoArgs += '--release'
    }

    & $cargo.Source @cargoArgs
    if ($LASTEXITCODE -ne 0) {
        throw "qualification_worker_build_failed_$LASTEXITCODE"
    }
}
finally {
    $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256 = $oldMediaSigner
    $env:GPUBNB_SOURCE_COMMIT = $oldSourceCommit
}

$profile = if ($Release) { 'release' } else { 'debug' }
$workerPath = Join-Path $repoRoot "native\windows-worker\target\$profile\gpubnb-windows-worker.exe"
$resolved = (Resolve-Path -LiteralPath $workerPath -ErrorAction Stop).Path
$policyRaw = (& $resolved --build-policy --json | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw 'qualification_worker_build_policy_unavailable'
}
$policy = $policyRaw | ConvertFrom-Json -ErrorAction Stop
if ($policy.schemaVersion -ne 1) {
    throw 'qualification_worker_build_policy_version'
}
if ([string]$policy.sourceCommit -cne $sourceCommit) {
    throw 'qualification_worker_build_policy_commit_mismatch'
}
if ([string]$policy.mediaSignerSha256 -cne $mediaSigner) {
    throw 'qualification_worker_build_policy_signer_mismatch'
}

[ordered]@{
    ok = $true
    sourceCommit = $sourceCommit
    workerPath = $resolved
    workerSha256BeforeSigning = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
    mediaSignerCertificateSha256 = $mediaSigner
    productionBookabilityChanged = $false
} | ConvertTo-Json -Depth 4
