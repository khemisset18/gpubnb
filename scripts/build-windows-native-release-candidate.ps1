#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
    [string]$NvCodecHeadersDir,

    [string]$OutputDirectory,

    # CI-built unsigned Agent for THIS exact source commit; copy it, never sign the source file.
    [Parameter(Mandatory = $true)]
    [string]$UnsignedAgentPath,

    [Parameter(Mandatory = $true)]
    [string]$UnsignedAgentSha256,

    # Approved PUBLIC certificate fingerprint; no key material in this parameter.
    [Parameter(Mandatory = $true)]
    [string]$ExpectedPublisherSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ExitCode {
    param([Parameter(Mandatory = $true)][string]$Step)
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE"
    }
}

function Get-ValidSigner {
    param([Parameter(Mandatory = $true)][string]$Path)

    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "release_candidate_signature_invalid:${Path}:$($signature.Status)"
    }
    if ($null -eq $signature.SignerCertificate) {
        throw "release_candidate_signer_missing:$Path"
    }
    return $signature.SignerCertificate
}

function Get-CertificateSha256 {
    param([Parameter(Mandatory = $true)]$Certificate)

    return $Certificate.GetCertHashString(
        [System.Security.Cryptography.HashAlgorithmName]::SHA256
    ).ToLowerInvariant()
}

function Assert-ProductionSigner {
    param([Parameter(Mandatory = $true)]$Certificate)

    $subject = [string]$Certificate.Subject
    if ($subject -match 'LOCAL PHYSICAL TEST ONLY') {
        throw 'release_candidate_qualification_certificate_forbidden'
    }
    if (-not $Certificate.HasPrivateKey) {
        throw 'release_candidate_private_key_unavailable'
    }
    if ($Certificate.NotBefore -gt (Get-Date) -or $Certificate.NotAfter -le (Get-Date)) {
        throw 'release_candidate_certificate_not_currently_valid'
    }
}

if ($env:OS -ne 'Windows_NT') {
    throw 'release_candidate_windows_required'
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$git = (Get-Command git.exe -ErrorAction Stop).Source
$cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
$msbuild = (Get-Command msbuild.exe -ErrorAction Stop).Source

$expectedPublisher = $ExpectedPublisherSha256.Replace(' ', '').ToLowerInvariant()
if ($expectedPublisher -cnotmatch '^[a-f0-9]{64}$' -or $expectedPublisher -ceq ('0' * 64)) {
    throw 'release_candidate_approved_publisher_sha256_invalid'
}
if ([string]::IsNullOrWhiteSpace($env:GPUBNB_APPROVED_PUBLISHER_CERTIFICATE_SHA256)) {
    throw 'release_candidate_approved_publisher_not_configured'
}
$approval = $env:GPUBNB_APPROVED_PUBLISHER_CERTIFICATE_SHA256.Replace(' ', '').ToLowerInvariant()
if ($approval -cne $expectedPublisher) {
    throw 'release_candidate_publisher_approval_mismatch'
}

$sourceCommit = (& $git -C $repoRoot rev-parse HEAD | Out-String).Trim()
Assert-ExitCode -Step 'git rev-parse'
if ($sourceCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'release_candidate_source_commit_invalid'
}

& $git -C $repoRoot diff --quiet --
if ($LASTEXITCODE -ne 0) { throw 'release_candidate_tracked_worktree_dirty' }
& $git -C $repoRoot diff --cached --quiet --
if ($LASTEXITCODE -ne 0) { throw 'release_candidate_index_dirty' }

# Fail before invoking any signer or running unsigned Agent code.
$expectedAgentHash = $UnsignedAgentSha256.Trim().ToLowerInvariant()
if ($expectedAgentHash -cnotmatch '^[0-9a-f]{64}$' -or $expectedAgentHash -ceq ('0' * 64)) {
    throw 'release_candidate_agent_expected_sha256_invalid'
}
if (-not (Test-Path -LiteralPath $UnsignedAgentPath -PathType Leaf)) {
    throw 'release_candidate_unsigned_agent_missing'
}
$agentInput = (Resolve-Path -LiteralPath $UnsignedAgentPath -ErrorAction Stop).Path
if ([IO.Path]::GetFileName($agentInput) -cne 'gpubnb-agent.exe') {
    throw 'release_candidate_unsigned_agent_wrong_filename'
}
$observedAgentHash = (Get-FileHash -LiteralPath $agentInput -Algorithm SHA256).Hash.ToLowerInvariant()
if ($observedAgentHash -cne $expectedAgentHash) {
    throw 'release_candidate_unsigned_agent_sha256_mismatch'
}
$agentInputSignature = Get-AuthenticodeSignature -LiteralPath $agentInput
if ($agentInputSignature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned -or
    $null -ne $agentInputSignature.SignerCertificate) {
    throw 'release_candidate_agent_input_must_be_unsigned'
}
$agentBytes = [IO.File]::ReadAllBytes($agentInput)
if ($agentBytes.Length -lt 512 -or [BitConverter]::ToUInt16($agentBytes, 0) -ne 0x5a4d) {
    throw 'release_candidate_agent_invalid_pe'
}
$agentPe = [BitConverter]::ToInt32($agentBytes, 0x3c)
if ($agentPe -lt 0 -or $agentPe + 264 -gt $agentBytes.Length -or
    [BitConverter]::ToUInt32($agentBytes, $agentPe) -ne 0x4550 -or
    [BitConverter]::ToUInt16($agentBytes, $agentPe + 4) -ne 0x8664 -or
    [BitConverter]::ToUInt16($agentBytes, $agentPe + 24) -ne 0x20b) {
    throw 'release_candidate_agent_not_amd64'
}

$thumbprint = "$env:GPUBNB_CODESIGN_THUMBPRINT".Replace(' ', '').ToUpperInvariant()
$timestampUrl = "$env:GPUBNB_CODESIGN_TIMESTAMP_URL".Trim()
if ([string]::IsNullOrWhiteSpace($thumbprint)) {
    throw 'release_candidate_codesign_thumbprint_missing'
}
if ([string]::IsNullOrWhiteSpace($timestampUrl)) {
    throw 'release_candidate_timestamp_url_missing'
}

$signingCertificate = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Thumbprint.Replace(' ', '').ToUpperInvariant() -eq $thumbprint } |
    Select-Object -First 1
if (-not $signingCertificate) {
    throw "release_candidate_codesign_certificate_not_found:$thumbprint"
}
Assert-ProductionSigner -Certificate $signingCertificate
if ((Get-CertificateSha256 -Certificate $signingCertificate) -cne $expectedPublisher) {
    throw 'release_candidate_publisher_certificate_not_approved'
}

$resolvedHeaders = (Resolve-Path -LiteralPath $NvCodecHeadersDir).Path
$header = Join-Path $resolvedHeaders 'nvEncodeAPI.h'
if (-not (Test-Path -LiteralPath $header -PathType Leaf)) {
    throw 'release_candidate_nvencode_header_missing'
}
$headerSource = Get-Content -LiteralPath $header -Raw
if ($headerSource -notmatch '#define\s+NVENCAPI_MAJOR_VERSION\s+13') {
    throw 'release_candidate_nvenc_api_major_unexpected'
}
if ($headerSource -notmatch '#define\s+NVENCAPI_MINOR_VERSION\s+0') {
    throw 'release_candidate_nvenc_api_minor_unexpected'
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot "dist\windows-native-release-candidate\$sourceCommit"
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = (Resolve-Path -LiteralPath $OutputDirectory).Path

if ([IO.Path]::GetFullPath($agentInput) -ieq
    [IO.Path]::GetFullPath((Join-Path $output 'gpubnb-agent.exe'))) {
    throw 'release_candidate_agent_input_must_be_separate_from_output'
}

# STEP 1: Build and sign the media DLL first. The worker embeds this publisher.
$mediaProject = Join-Path $repoRoot 'native\windows-media\GPUbnbWindowsMedia.vcxproj'
$mediaArgs = @(
    $mediaProject,
    '/m',
    '/p:Configuration=Release',
    '/p:Platform=x64',
    "/p:NvCodecHeadersDir=$resolvedHeaders",
    '/p:RunCodeAnalysis=true'
)
& $msbuild @mediaArgs
Assert-ExitCode -Step 'media build'

$media = Join-Path $repoRoot 'native\windows-media\bin\Release\GPUbnbWindowsMedia.dll'
if (-not (Test-Path -LiteralPath $media -PathType Leaf)) {
    throw 'release_candidate_media_missing'
}
& (Join-Path $repoRoot 'scripts\sign-windows-authenticode.ps1') -Path @($media)
Assert-ExitCode -Step 'media Authenticode signing'
$mediaCert = Get-ValidSigner -Path $media
Assert-ProductionSigner -Certificate $mediaCert
$mediaSignerSha256 = Get-CertificateSha256 -Certificate $mediaCert

# STEP 2: Build the worker with exact source + media-publisher policy, then sign it.
$oldMediaSigner = $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256
$oldSourceCommit = $env:GPUBNB_SOURCE_COMMIT
try {
    $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256 = $mediaSignerSha256
    $env:GPUBNB_SOURCE_COMMIT = $sourceCommit
    $workerArgs = @(
        'build',
        '--locked',
        '--release',
        '--manifest-path', (Join-Path $repoRoot 'native\windows-worker\Cargo.toml'),
        '--bin', 'gpubnb-windows-worker'
    )
    & $cargo @workerArgs
    Assert-ExitCode -Step 'worker build'
}
finally {
    $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256 = $oldMediaSigner
    $env:GPUBNB_SOURCE_COMMIT = $oldSourceCommit
}

$worker = Join-Path $repoRoot 'native\windows-worker\target\release\gpubnb-windows-worker.exe'
if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) {
    throw 'release_candidate_worker_missing'
}

$workerPolicy = (& $worker --build-policy --json | Out-String).Trim() | ConvertFrom-Json
Assert-ExitCode -Step 'worker build-policy'
if ([string]$workerPolicy.sourceCommit -cne $sourceCommit) {
    throw 'release_candidate_worker_source_commit_mismatch'
}
if ([string]$workerPolicy.mediaSignerSha256 -cne $mediaSignerSha256) {
    throw 'release_candidate_worker_media_signer_mismatch'
}

& (Join-Path $repoRoot 'scripts\sign-windows-authenticode.ps1') -Path @($worker)
Assert-ExitCode -Step 'worker Authenticode signing'
$workerCert = Get-ValidSigner -Path $worker
Assert-ProductionSigner -Certificate $workerCert
$workerSignerSha256 = Get-CertificateSha256 -Certificate $workerCert

# STEP 3: Build the distinct Stage 4 helper with exact worker publisher policy.
$oldWorkerSigner = $env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256
try {
    $env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256 = $workerSignerSha256
    $helperArgs = @(
        'build',
        '--locked',
        '--release',
        '--manifest-path', (Join-Path $repoRoot 'native\windows-stream-helper\Cargo.toml'),
        '--features', 'release-candidate',
        '--bin', 'gpubnb-windows-stream'
    )
    & $cargo @helperArgs
    Assert-ExitCode -Step 'release-candidate helper build'
}
finally {
    $env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256 = $oldWorkerSigner
}

$helper = Join-Path $repoRoot 'native\windows-stream-helper\target\release\gpubnb-windows-stream.exe'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw 'release_candidate_helper_missing'
}
& (Join-Path $repoRoot 'scripts\sign-windows-authenticode.ps1') -Path @($helper)
Assert-ExitCode -Step 'helper Authenticode signing'
$helperCert = Get-ValidSigner -Path $helper
Assert-ProductionSigner -Certificate $helperCert
$helperSignerSha256 = Get-CertificateSha256 -Certificate $helperCert

if ($workerSignerSha256 -cne $mediaSignerSha256 -or
    $helperSignerSha256 -cne $workerSignerSha256) {
    throw 'release_candidate_user_mode_publisher_mismatch'
}

# STEP 4: Copy CI-built AMD64 Agent to release output before signing.
# Never modify the downloaded unsigned source artifact.
$agentCandidate = Join-Path $output 'gpubnb-agent.exe'
if ($agentInput -ceq $agentCandidate) {
    throw 'release_candidate_agent_input_must_be_separate_from_output'
}
Copy-Item -LiteralPath $agentInput -Destination $agentCandidate -Force
if ((Get-FileHash -LiteralPath $agentCandidate -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedAgentHash) {
    throw 'release_candidate_agent_staged_sha256_mismatch'
}
& (Join-Path $repoRoot 'scripts\sign-windows-authenticode.ps1') -Path @($agentCandidate)
Assert-ExitCode -Step 'agent Authenticode signing'
$agentCert = Get-ValidSigner -Path $agentCandidate
Assert-ProductionSigner -Certificate $agentCert
$agentSignerSha256 = Get-CertificateSha256 -Certificate $agentCert
if ($agentSignerSha256 -cne $workerSignerSha256) {
    throw 'release_candidate_agent_publisher_mismatch'
}
$agentInfoRaw = (& $agentCandidate build-info | Out-String).Trim()
Assert-ExitCode -Step 'signed agent build-info'
try {
    $agentInfo = $agentInfoRaw | ConvertFrom-Json -ErrorAction Stop
} catch {
    throw 'release_candidate_agent_build_info_invalid'
}
if ($agentInfo.frozen -ne $true -or [string]$agentInfo.buildCommit -cne $sourceCommit.Substring(0, 12) -or
    [string]$agentInfo.agentVersion -cne '0.6.6') {
    throw 'release_candidate_agent_build_identity_mismatch'
}

$payload = [ordered]@{
    'GPUbnbWindowsMedia.dll' = $media
    'gpubnb-windows-worker.exe' = $worker
    'gpubnb-windows-stream.exe' = $helper
    'gpubnb-agent.exe' = $agentCandidate
}
foreach ($entry in $payload.GetEnumerator()) {
    $destination = Join-Path $output $entry.Key
    if ([IO.Path]::GetFullPath($entry.Value) -ine [IO.Path]::GetFullPath($destination)) {
        Copy-Item -LiteralPath $entry.Value -Destination $destination -Force
    }
}

$files = @()
foreach ($name in $payload.Keys) {
    $path = Join-Path $output $name
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "release_candidate_copied_signature_invalid:$name"
    }
    $files += [ordered]@{
        name = $name
        sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        signerCertificateSha256 = Get-CertificateSha256 -Certificate $signature.SignerCertificate
    }
}

$manifest = [ordered]@{
    schemaVersion = 1
    sourceCommit = $sourceCommit
    mutationAuthority = 'release-candidate'
    nvencApi = '13.0'
    minimumNvidiaWindowsDriver = '570.00'
    nvencUpgradePolicy = 'SDK 13.1 requires NVIDIA Windows driver 610+ and a fresh physical qualification'
    userModePublisherCertificateSha256 = $workerSignerSha256
    explicitlyApprovedPublisherSha256 = $expectedPublisher
    agentUnsignedInputSha256 = $expectedAgentHash
    agentBuildCommit = $sourceCommit.Substring(0, 12)
    files = $files
    iddDriverProductionSigningRequired = $true
    iddDriverIncluded = $false
    publicBookabilityEnabled = $false
    productionBookabilityChanged = $false
}

$manifestPath = Join-Path $output 'windows-native-release-candidate.manifest.json'
[IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false)
)

$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
[ordered]@{
    ok = $true
    sourceCommit = $sourceCommit
    outputDirectory = $output
    manifestPath = $manifestPath
    manifestSha256 = $manifestHash
    publisherCertificateSha256 = $workerSignerSha256
    publicBookabilityEnabled = $false
} | ConvertTo-Json -Depth 6
