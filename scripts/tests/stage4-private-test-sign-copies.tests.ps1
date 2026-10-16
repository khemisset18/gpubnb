#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$script=Join-Path $PSScriptRoot '..\stage4-private-test-sign-copies.ps1'
$script=(Resolve-Path -LiteralPath $script).Path
$tokens=$null
$errors=$null
[void][System.Management.Automation.Language.Parser]::ParseFile($script,[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { throw "stage4_private_staging_parser_failed:$($errors.Count)" }
Write-Host 'PASS offline staging parser syntax'
$source=[IO.File]::ReadAllText($script)
foreach ($guard in @(
    'SignCopiesForPrivateTest', 'stage4_private_unsigned_file_hash_mismatch',
    'stage4_private_source_must_be_unsigned', 'stage4_private_test_certificate_unavailable',
    'stage4_private_output_must_be_new', 'stage4_private_installed_path_forbidden',
    'stage4_private_signature_not_valid', "installationPerformed=$false",
    "publicBookabilityEnabled=$false", "LOCAL_TEST_ONLY_NOT_RELEASE"
)) {
    if (-not $source.Contains($guard)) { throw "stage4_private_staging_guard_missing:$guard" }
}
if ($source -match 'Stop-Service|Set-Service|Import-Certificate|Export-PfxCertificate|Restart-Computer') {
    throw 'stage4_private_staging_forbidden_action'
}
Write-Host 'PASS test-only no-install policy markers'
$dir=Join-Path ([IO.Path]::GetTempPath()) ('stage4-private-preflight-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($dir)
try {
    $errorMessage=''
    try { & $script -UnsignedDirectory $dir | Out-Null } catch { $errorMessage=$_.Exception.Message }
    if (-not $errorMessage.StartsWith('stage4_private_unsigned_file_missing:')) {
        throw "stage4_private_missing_file_not_rejected:$errorMessage"
    }
    Write-Host 'PASS missing unsigned file rejected without side effects'
    [IO.File]::WriteAllText((Join-Path $dir 'GPUbnbWindowsMedia.dll'),'not a real DLL')
    $errorMessage=''
    try { & $script -UnsignedDirectory $dir -SignCopiesForPrivateTest -OutputDirectory (Join-Path $dir 'out') | Out-Null }
    catch { $errorMessage=$_.Exception.Message }
    if (-not $errorMessage.StartsWith('stage4_private_unsigned_file_hash_mismatch:')) {
        throw "stage4_private_wrong_hash_not_rejected:$errorMessage"
    }
    if (Test-Path (Join-Path $dir 'out')) { throw 'stage4_private_created_output_on_failed_hash' }
    Write-Host 'PASS wrong hash rejected before any signer is touched'
} finally {
    Remove-Item -LiteralPath $dir -Force -Recurse -ErrorAction SilentlyContinue
}
