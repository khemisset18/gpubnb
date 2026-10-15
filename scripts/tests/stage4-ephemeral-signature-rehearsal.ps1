#Requires -Version 5.1
# Isolated, non-production signature policy rehearsal on an ephemeral GitHub Windows runner.
# Signs only a disposable PowerShell fixture; does not sign, package or upload GPUbnb binaries.
[CmdletBinding()]
param(
    [string]$Verifier = (Join-Path $PSScriptRoot '..\verify-windows-authenticode.ps1')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true') {
    throw 'signature_rehearsal_requires_ephemeral_github_windows_runner'
}
foreach ($secretName in @(
    'GPUBNB_CODESIGN_THUMBPRINT',
    'GPUBNB_CODESIGN_PFX_BASE64',
    'GPUBNB_CODESIGN_PFX_PASSWORD',
    'GPUBNB_CODESIGN_TIMESTAMP_URL'
)) {
    if (Test-Path "Env:$secretName") { throw 'real_signing_environment_forbidden' }
}
$Verifier = (Resolve-Path -LiteralPath $Verifier).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('gpubnb-ephemeral-signing-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$cert = $null
$rootImported = $false

function Assert-Rejected {
    param([scriptblock]$Call, [string[]]$ExpectedPrefixes, [string]$TestName)
    $message = ''
    try {
        & $Call | Out-Null
    } catch {
        $message = $_.Exception.Message
    }
    foreach ($prefix in $ExpectedPrefixes) {
        if ($message.StartsWith($prefix, [StringComparison]::Ordinal)) {
            Write-Host "PASS $TestName"
            return
        }
    }
    throw "signature_rehearsal_expected_rejection_missing:$TestName"
}

try {
    # Short-lived *local-test-only* signing key, generated within this runner,
    # marked non-exportable, never published or used as a release identity.
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject 'CN=GPUbnb LOCAL PHYSICAL TEST ONLY EPHEMERAL CI' `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -KeyExportPolicy NonExportable `
        -NotAfter (Get-Date).AddHours(2)
    if (-not $cert.HasPrivateKey) { throw 'ephemeral_test_key_missing' }
    $thumbprint = $cert.Thumbprint
    $publicHash = $cert.GetCertHashString(
        [Security.Cryptography.HashAlgorithmName]::SHA256
    ).ToLowerInvariant()
    if ($publicHash -cnotmatch '^[a-f0-9]{64}$') { throw 'ephemeral_public_hash_invalid' }

    # Trust ONLY this generated public certificate in the runner's *current user*
    # store; never modify machine root trust or a user's physical PC.
    $cerFile = Join-Path $root 'test-only.cer'
    Export-Certificate -Cert $cert -FilePath $cerFile | Out-Null
    $imported = Import-Certificate -FilePath $cerFile -CertStoreLocation 'Cert:\CurrentUser\Root'
    if (-not @($imported).Count) { throw 'ephemeral_test_trust_failed' }
    $rootImported = $true

    $signedPath = Join-Path $root 'ephemeral-fixture.ps1'
    $unsignedPath = Join-Path $root 'unsigned-fixture.ps1'
    [IO.File]::WriteAllText($signedPath, 'Write-Output "CI TEST ONLY"'+[Environment]::NewLine)
    [IO.File]::WriteAllText($unsignedPath, 'Write-Output "UNSIGNED CI TEST"'+[Environment]::NewLine)

    $signature = Set-AuthenticodeSignature -FilePath $signedPath -Certificate $cert -HashAlgorithm SHA256
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "ephemeral_test_signature_failed:$($signature.Status)"
    }

    $report = & $Verifier -Path $signedPath -Required -ExpectedSignerSha256 $publicHash |
        ConvertFrom-Json
    if (-not $report.valid -or -not $report.signed -or $report.timestamped -or
        $report.signerCertificateSha256 -cne $publicHash) {
        throw 'ephemeral_pinned_signed_fixture_validation_failed'
    }
    Write-Host 'PASS valid ephemeral signature with public SHA-256 pin'

    Assert-Rejected -TestName 'wrong publisher pin' `
        -Call { & $Verifier -Path $signedPath -Required -ExpectedSignerSha256 ('f' * 64) } `
        -ExpectedPrefixes @('authenticode_unapproved_signer:')
    Assert-Rejected -TestName 'required timestamp missing' `
        -Call { & $Verifier -Path $signedPath -Required -RequireTimestamp -ExpectedSignerSha256 $publicHash } `
        -ExpectedPrefixes @('authenticode_timestamp_required_but_missing:')
    Assert-Rejected -TestName 'unsigned fixture rejected' `
        -Call { & $Verifier -Path $unsignedPath -Required } `
        -ExpectedPrefixes @('authenticode_required_but_missing:')
    [IO.File]::AppendAllText($signedPath, '# signed bytes tampered'+[Environment]::NewLine)
    Assert-Rejected -TestName 'tampered signature rejected' `
        -Call { & $Verifier -Path $signedPath -Required -ExpectedSignerSha256 $publicHash } `
        -ExpectedPrefixes @('authenticode_present_but_invalid:', 'authenticode_required_but_missing:')

    Write-Host 'PASS EPHEMERAL TEST ONLY: no production signer, no timestamp, no signed GPUbnb artifacts'
}
finally {
    # Defense in depth: delete ephemeral user's test cert/key and public test trust.
    if ($null -ne $cert) {
        if ($rootImported) {
            Remove-Item -LiteralPath ("Cert:\CurrentUser\Root\" + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
