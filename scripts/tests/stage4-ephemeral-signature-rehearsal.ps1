#Requires -Version 5.1
# Run ONLY on ephemeral GitHub-hosted Windows runner. No production signing.
[CmdletBinding()]
param([string]$Verifier = (Join-Path $PSScriptRoot '..\verify-windows-authenticode.ps1'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true') {
    throw 'signature_rehearsal_requires_ephemeral_github_windows_runner'
}
foreach ($secretName in @(
    'GPUBNB_CODESIGN_THUMBPRINT','GPUBNB_CODESIGN_PFX_BASE64',
    'GPUBNB_CODESIGN_PFX_PASSWORD','GPUBNB_CODESIGN_TIMESTAMP_URL'
)) {
    if (Test-Path "Env:$secretName") { throw 'real_signing_environment_forbidden' }
}
$Verifier = (Resolve-Path -LiteralPath $Verifier).Path
$directory = Join-Path ([IO.Path]::GetTempPath()) ('gpubnb-signature-fixture-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($directory)
$cert = $null

function Assert-Rejected {
    param([scriptblock]$Call, [string[]]$ExpectedPrefixes, [string]$Name)
    $caught = ''
    try { & $Call | Out-Null } catch { $caught = $_.Exception.Message }
    foreach ($prefix in $ExpectedPrefixes) {
        if ($caught.StartsWith($prefix, [StringComparison]::Ordinal)) {
            Write-Host "PASS $Name"
            return
        }
    }
    throw "rehearsal_expected_rejection_missing:$Name"
}

try {
    # Positive verification with an existing Microsoft Windows signed PE.
    # No private key or trust-store mutation is required.
    $knownSigned = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $knownSignature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $knownSigned
    if ($knownSignature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
        throw 'existing_windows_pe_signature_invalid'
    }
    $knownHash = $knownSignature.SignerCertificate.GetCertHashString(
        [Security.Cryptography.HashAlgorithmName]::SHA256
    ).ToLowerInvariant()
    $valid = & $Verifier -Path $knownSigned -Required -ExpectedSignerSha256 $knownHash | ConvertFrom-Json
    if (-not $valid.valid -or -not $valid.signed -or
        $valid.signerCertificateSha256 -cne $knownHash) {
        throw 'trusted_windows_pe_signer_verification_failed'
    }
    Write-Host 'PASS trusted signed Windows PE with exact public signer pin'

    $wrong = if ($knownHash -cne ('f' * 64)) { 'f' * 64 } else { 'e' * 64 }
    Assert-Rejected -Name 'wrong real PE signer pin rejected' `
        -Call { & $Verifier -Path $knownSigned -Required -ExpectedSignerSha256 $wrong } `
        -ExpectedPrefixes @('authenticode_unapproved_signer:')

    $signedPath = Join-Path $directory 'test-only-signed.ps1'
    $unsignedPath = Join-Path $directory 'test-only-unsigned.ps1'
    [IO.File]::WriteAllText($signedPath, 'Write-Output "TEST ONLY"'+[Environment]::NewLine)
    [IO.File]::WriteAllText($unsignedPath, 'Write-Output "UNSIGNED"'+[Environment]::NewLine)
    Assert-Rejected -Name 'unsigned fixture rejected' `
        -Call { & $Verifier -Path $unsignedPath -Required } `
        -ExpectedPrefixes @('authenticode_required_but_missing:')

    # Create only an unapproved/nonexportable TEST key. Do NOT import it to any
    # trust store, and never export its private key or publish an artifact.
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject 'CN=GPUbnb LOCAL PHYSICAL TEST ONLY EPHEMERAL CI' `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -KeyExportPolicy NonExportable `
        -NotAfter (Get-Date).AddHours(2)
    if (-not $cert.HasPrivateKey) { throw 'test_private_key_missing' }
    $publicHash = $cert.GetCertHashString(
        [Security.Cryptography.HashAlgorithmName]::SHA256
    ).ToLowerInvariant()
    if ($publicHash -cnotmatch '^[0-9a-f]{64}$') { throw 'test_public_hash_invalid' }

    $signed = Set-AuthenticodeSignature -FilePath $signedPath -Certificate $cert -HashAlgorithm SHA256
    if ($null -eq $signed.SignerCertificate) { throw 'test_fixture_not_actually_signed' }
    $observed = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $signedPath
    if ($null -eq $observed.SignerCertificate -or
        $observed.SignerCertificate.GetCertHashString(
            [Security.Cryptography.HashAlgorithmName]::SHA256
        ).ToLowerInvariant() -cne $publicHash) {
        throw 'test_fixture_signer_certificate_mismatch'
    }
    if ($observed.Status -eq [Management.Automation.SignatureStatus]::Valid) {
        throw 'untrusted_test_signer_unexpectedly_trusted'
    }
    Assert-Rejected -Name 'untrusted test signature rejected' `
        -Call { & $Verifier -Path $signedPath -Required -ExpectedSignerSha256 $publicHash } `
        -ExpectedPrefixes @('authenticode_present_but_invalid:')

    [IO.File]::AppendAllText($signedPath, '# tampered'+[Environment]::NewLine)
    Assert-Rejected -Name 'tampered test signature rejected' `
        -Call { & $Verifier -Path $signedPath -Required } `
        -ExpectedPrefixes @('authenticode_present_but_invalid:', 'authenticode_required_but_missing:')
    Write-Host 'PASS test-only Windows signing verified fail closed; no production authority or timestamp'
}
finally {
    if ($null -ne $cert) {
        Remove-Item -LiteralPath ('Cert:\CurrentUser\My\' + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
}
