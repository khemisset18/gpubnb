#Requires -Version 5.1
# PRIVATE PHYSICAL QUALIFICATION ONLY. Never installs or modifies a service.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$UnsignedDirectory,
    [switch]$SignCopiesForPrivateTest,
    [string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
    throw 'stage4_private_windows_x64_required'
}
$root=(Resolve-Path -LiteralPath $UnsignedDirectory -ErrorAction Stop).Path
$sourceCommit='2b055992f7521505d0387dd4c876e36794fffd63'
$testPin='200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a'
$files=[ordered]@{
    'GPUbnbWindowsMedia.dll'='2817cc7f7852d3d5001b57f386dd51073a4772b7b3f19ed9d81b83ee52e1808a'
    'gpubnb-windows-worker.exe'='632bdfb73a0cd6c57e6655ca6c7813a55b4cf8560016860c4d38dead1694adc2'
    'gpubnb-windows-stream.exe'='258f61515a8ca919e945957699283550e9f5fc0bed421dbaa82214ecc26fdb30'
    'gpubnb-agent.exe'='9de3ea6016048799675ac59709d4530eab669cf9ec257fb762eb26ce44dd6070'
}
$sourcePaths=[ordered]@{}
foreach ($name in $files.Keys) {
    $path=Join-Path $root $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "stage4_private_unsigned_file_missing:$name"
    }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $files[$name]) {
        throw "stage4_private_unsigned_file_hash_mismatch:$name"
    }
    $sig=Get-AuthenticodeSignature -LiteralPath $path
    if ($sig.Status -ne [Management.Automation.SignatureStatus]::NotSigned -or $null -ne $sig.SignerCertificate) {
        throw "stage4_private_source_must_be_unsigned:$name"
    }
    $sourcePaths[$name]=$path
}
# Test-only private key stays in PC1 CurrentUser store; never exported or copied.
$matches=@(Get-ChildItem Cert:\CurrentUser\My | Where-Object {
    $_.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -ceq $testPin
})
if ($matches.Count -ne 1 -or -not $matches[0].HasPrivateKey) {
    throw 'stage4_private_test_certificate_unavailable'
}
$cert=$matches[0]
if ($cert.Subject -notmatch 'LOCAL PHYSICAL TEST ONLY' -or
    $cert.NotBefore -gt (Get-Date) -or $cert.NotAfter -le (Get-Date).AddHours(24)) {
    throw 'stage4_private_test_certificate_invalid_or_expiring'
}
if (-not $SignCopiesForPrivateTest) {
    [ordered]@{
        mode='read_only';ok=$true;sourceCommit=$sourceCommit;
        filesVerified=$files.Count;signingPerformed=$false;installationPerformed=$false;
        privateTestPinSha256=$testPin;expiresUtc=$cert.NotAfter.ToUniversalTime().ToString('o');
        publicBookabilityEnabled=$false
    } | ConvertTo-Json
    return
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { throw 'stage4_private_output_required' }
$target=[IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $target) { throw 'stage4_private_output_must_be_new' }
$sourcePath=[IO.Path]::GetFullPath($root).TrimEnd('\')
if ($target.TrimEnd('\') -ieq $sourcePath -or
    $target.StartsWith($sourcePath+'\',[StringComparison]::OrdinalIgnoreCase)) {
    throw 'stage4_private_output_must_be_separate'
}
if ($target -match '(?i)\\Program Files\\|\\Windows\\|\\ProgramData\\GPUbnb\\') {
    throw 'stage4_private_installed_path_forbidden'
}
$foundSignTool=Get-Command signtool.exe -ErrorAction SilentlyContinue
$signTool=if ($null -ne $foundSignTool) { $foundSignTool.Source } else { $null }
if (-not $signTool) {
    $kits=Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Windows Kits\10\bin'
    $signTool=Get-ChildItem -LiteralPath $kits -Filter signtool.exe -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signTool) { throw 'stage4_private_signtool_required' }
# No timestamp service is trusted for this local test: unsigned source and
# signed copies are NOT installable releases, and expire with test certificate.
[void][IO.Directory]::CreateDirectory($target)
try {
    $records=@()
    foreach ($name in $files.Keys) {
        $copy=Join-Path $target $name
        Copy-Item -LiteralPath $sourcePaths[$name] -Destination $copy -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant() -cne $files[$name]) {
            throw "stage4_private_copy_hash_mismatch:$name"
        }
        & $signTool sign /sha1 $cert.Thumbprint /fd SHA256 /v $copy | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "stage4_private_sign_failed:$name" }
        $sig=Get-AuthenticodeSignature -LiteralPath $copy
        if ($sig.Status -ne [Management.Automation.SignatureStatus]::Valid -or
            $null -eq $sig.SignerCertificate -or
            $sig.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -cne $testPin) {
            throw "stage4_private_signature_not_valid:$name"
        }
        $records+= [ordered]@{
            name=$name;unsignedSha256=$files[$name];
            signedSha256=(Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $report=[ordered]@{
        schemaVersion=1;kind='LOCAL_TEST_ONLY_NOT_RELEASE';sourceCommit=$sourceCommit;
        signedAtUtc=[DateTime]::UtcNow.ToString('o');
        testPublisherSha256=$testPin;expiresUtc=$cert.NotAfter.ToUniversalTime().ToString('o');
        timestamped=$false;publicPublisherApproved=$false;
        driverModified=$false;installationPerformed=$false;publicBookabilityEnabled=$false;
        files=$records
    }
    [IO.File]::WriteAllText((Join-Path $target 'PRIVATE-TEST-ONLY.json'),
        ($report|ConvertTo-Json -Depth 8)+[Environment]::NewLine,
        [Text.UTF8Encoding]::new($false))
    $report|ConvertTo-Json -Depth 8
} catch {
    Remove-Item -LiteralPath $target -Force -Recurse -ErrorAction SilentlyContinue
    throw
}
