#Requires -Version 5.1
# Negative-only preflight tests. No signing keys, trust changes or installation.
[CmdletBinding()]
param(
    [string]$Builder = (Join-Path $PSScriptRoot '..\build-windows-native-release-candidate.ps1')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Builder = (Resolve-Path -LiteralPath $Builder).Path
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
    $Builder, [ref]$tokens, [ref]$errors
)
if ($errors.Count -gt 0) { throw "release_builder_syntax_invalid:$($errors.Count)" }
Write-Host 'PASS release builder syntax'

# Source contract: the signed release candidate must have four signed PE files,
# including an immutable unsigned Agent input hash and a frozen build identity.
$source = [IO.File]::ReadAllText($Builder)
foreach ($marker in @(
    'release_candidate_unsigned_agent_missing',
    'release_candidate_unsigned_agent_sha256_mismatch',
    'release_candidate_agent_input_must_be_unsigned',
    'release_candidate_agent_not_amd64',
    'release_candidate_agent_build_identity_mismatch',
    'release_candidate_agent_publisher_mismatch',
    'release_candidate_approved_publisher_sha256_invalid',
    'release_candidate_approved_publisher_not_configured',
    'release_candidate_publisher_approval_mismatch',
    'release_candidate_publisher_certificate_not_approved',
    'explicitlyApprovedPublisherSha256 = $expectedPublisher',
    "'gpubnb-agent.exe' = "+'$agentCandidate',
    'agentUnsignedInputSha256 = $expectedAgentHash',
    'agentBuildCommit = $sourceCommit.Substring(0, 12)'
)) {
    if (-not $source.Contains($marker)) { throw "release_builder_gate_missing:$marker" }
}
Write-Host 'PASS four-component static release contract'

$folder = Join-Path ([IO.Path]::GetTempPath()) ('gpubnb-rc-preflight-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($folder)
function Test-Reject {
    param([string]$Name,[scriptblock]$Action,[string]$Expected)
    $message = ''
    try { & $Action | Out-Null } catch { $message = $_.Exception.Message }
    if (-not $message.StartsWith($Expected,[StringComparison]::Ordinal)) {
        throw "unexpected_preflight_result:${Name}:$message"
    }
    Write-Host "PASS $Name"
}
$priorApproval = [Environment]::GetEnvironmentVariable('GPUBNB_APPROVED_PUBLISHER_CERTIFICATE_SHA256')
try {
    $missing = Join-Path $folder 'gpubnb-agent.exe'
    $fake = Join-Path $folder 'fake'
    $badHash = '0' * 64
    $testApprovedPublisher = 'a' * 64
    [Environment]::SetEnvironmentVariable('GPUBNB_APPROVED_PUBLISHER_CERTIFICATE_SHA256', $null)
    Test-Reject 'approval must be separately configured' {
        & $Builder -NvCodecHeadersDir $folder -UnsignedAgentPath $missing -UnsignedAgentSha256 ('a' * 64) -ExpectedPublisherSha256 $testApprovedPublisher
    } 'release_candidate_approved_publisher_not_configured'
    [Environment]::SetEnvironmentVariable('GPUBNB_APPROVED_PUBLISHER_CERTIFICATE_SHA256', $testApprovedPublisher)
    Test-Reject 'malformed approved signer pin rejected' {
        & $Builder -NvCodecHeadersDir $folder -UnsignedAgentPath $missing -UnsignedAgentSha256 ('a' * 64) -ExpectedPublisherSha256 ('z' * 64)
    } 'release_candidate_approved_publisher_sha256_invalid'
    Test-Reject 'publisher approval mismatch rejected' {
        & $Builder -NvCodecHeadersDir $folder -UnsignedAgentPath $missing -UnsignedAgentSha256 ('a' * 64) -ExpectedPublisherSha256 ('b' * 64)
    } 'release_candidate_publisher_approval_mismatch'
    Test-Reject 'invalid agent input hash rejected before signing' {
        & $Builder -NvCodecHeadersDir $folder -UnsignedAgentPath $missing -UnsignedAgentSha256 $badHash -ExpectedPublisherSha256 $testApprovedPublisher
    } 'release_candidate_agent_expected_sha256_invalid'
    Test-Reject 'missing agent binary rejected before signing' {
        & $Builder -NvCodecHeadersDir $folder -UnsignedAgentPath $missing -UnsignedAgentSha256 ('a' * 64) -ExpectedPublisherSha256 $testApprovedPublisher
    } 'release_candidate_unsigned_agent_missing'
    [IO.File]::WriteAllText($missing,'not an executable')
    $actualHash = (Get-FileHash -LiteralPath $missing -Algorithm SHA256).Hash
    Test-Reject 'mismatched Agent SHA256 rejected before signing' {
        & $Builder -NvCodecHeadersDir $folder -UnsignedAgentPath $missing -UnsignedAgentSha256 ('a' * 64) -ExpectedPublisherSha256 $testApprovedPublisher
    } 'release_candidate_unsigned_agent_sha256_mismatch'
    Test-Reject 'non-PE Agent rejected before signing' {
        & $Builder -NvCodecHeadersDir $folder -UnsignedAgentPath $missing -UnsignedAgentSha256 $actualHash -ExpectedPublisherSha256 $testApprovedPublisher
    } 'release_candidate_agent_input_must_be_unsigned'
    Write-Host 'PASS negative preflight: no signing or trust-store mutations'
} finally {
    [Environment]::SetEnvironmentVariable('GPUBNB_APPROVED_PUBLISHER_CERTIFICATE_SHA256', $priorApproval)
    Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue
}
