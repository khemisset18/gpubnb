#Requires -Version 5.1
# Adversarial offline tests only: no TSA request, key, certificate store, service or PE execution.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$script=(Resolve-Path (Join-Path $PSScriptRoot '..\stage4-prepare-timestamped-rollback.ps1')).Path
$tokens=$null;$parseErrors=$null
[void][Management.Automation.Language.Parser]::ParseFile($script,[ref]$tokens,[ref]$parseErrors)
if(@($parseErrors).Count -ne 0){throw ('stage4_rollback_parser_failed:'+$parseErrors[0].Message)}
$source=[IO.File]::ReadAllText($script)
foreach($guard in @(
    'stage4_rollback_manifest_hash_mismatch',
    'stage4_rollback_component_hash_mismatch',
    'stage4_rollback_signature_invalid',
    'stage4_rollback_https_tsa_required',
    'stage4_rollback_timestamp_deadline_too_close',
    'INCOMPLETE-DO-NOT-RESTORE.txt',
    'stage4_rollback_timestamp_verify_failed',
    'readyToRestore=$false',
    'installationPerformed=$false',
    'trustChanged=$false'
)){
    if(-not $source.Contains($guard)){throw ('stage4_rollback_policy_guard_missing:'+$guard)}
}
if($source -match 'Stop-Service|Restart-Service|Set-Service|Import-Certificate|Set-ExecutionPolicy|Export-PfxCertificate|bcdedit|testsigning'){
    throw 'stage4_rollback_forbidden_mutation'
}
$pin='200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a'
$hash='aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'
$folder=Join-Path ([IO.Path]::GetTempPath()) ('stage4-rollback-test-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($folder)
$output=Join-Path ([IO.Path]::GetTempPath()) ('stage4-rollback-forbidden-'+[Guid]::NewGuid().ToString('N'))
try{
    function Expect-Error([string]$Expected, [scriptblock]$Command){
        $actual=''
        try { & $Command | Out-Null } catch { $actual=$_.Exception.Message }
        if(-not $actual.StartsWith($Expected,[StringComparison]::Ordinal)){
            throw ('stage4_rollback_test_expected:'+$Expected+':actual:'+$actual)
        }
    }
    Expect-Error 'stage4_rollback_https_tsa_required' {
        & $script -BackupDirectory $folder -ExpectedBackupManifestSha256 $hash -ExpectedSignerSha256 $pin -CreateTimestampedCopies -TimestampUrl 'http://untrusted.example' -OutputDirectory $output
    }
    Write-Host 'PASS non-HTTPS timestamp server rejected before any request'
    Expect-Error 'stage4_rollback_create_switch_required' {
        & $script -BackupDirectory $folder -ExpectedBackupManifestSha256 $hash -ExpectedSignerSha256 $pin -TimestampUrl 'https://timestamp.example.invalid'
    }
    Write-Host 'PASS timestamp URL cannot be supplied without explicit opt-in'
    Expect-Error 'stage4_rollback_manifest_missing' {
        & $script -BackupDirectory $folder -ExpectedBackupManifestSha256 $hash -ExpectedSignerSha256 $pin
    }
    [IO.File]::WriteAllText((Join-Path $folder 'backup.manifest.json'),'{"schemaVersion":0,"kind":"INVALID","installationPerformed":false,"privateKeyExported":false,"serviceModified":false}')
    Expect-Error 'stage4_rollback_manifest_hash_mismatch' {
        & $script -BackupDirectory $folder -ExpectedBackupManifestSha256 $hash -ExpectedSignerSha256 $pin
    }
    Write-Host 'PASS wrong backup manifest SHA rejected before any signer interaction'
    $realHash=(Get-FileHash (Join-Path $folder 'backup.manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    Expect-Error 'stage4_rollback_manifest_policy_mismatch' {
        & $script -BackupDirectory $folder -ExpectedBackupManifestSha256 $realHash -ExpectedSignerSha256 $pin
    }
    if(Test-Path -LiteralPath $output){throw 'stage4_rollback_created_output_during_failed_preflight'}
    Write-Host 'PASS malformed backup rejected without output or machine mutation'
}finally{
    Remove-Item -LiteralPath $folder -Force -Recurse -ErrorAction SilentlyContinue
}
Write-Host 'PASS all rollback offline preflight tests'
