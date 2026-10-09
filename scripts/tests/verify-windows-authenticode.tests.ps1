param(
    [string]$Verifier = (Join-Path $PSScriptRoot '..\verify-windows-authenticode.ps1')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Verifier = (Resolve-Path -LiteralPath $Verifier).Path
$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
    $Verifier, [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw "verifier_syntax_errors:$($parseErrors.Count)"
}
$passed = 1
Write-Host 'PASS verifier syntax'

# Existing runner files only: no certificate generation, trust-store changes or signing.
$liveSigned = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$liveSignature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $liveSigned
if ($liveSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw 'runner_existing_signature_not_valid'
}
$liveHash = $liveSignature.SignerCertificate.GetCertHashString(
    [System.Security.Cryptography.HashAlgorithmName]::SHA256
)
$liveReport = & $Verifier -Path $liveSigned -Required -ExpectedSignerSha256 $liveHash |
    ConvertFrom-Json
if (-not $liveReport.valid -or -not $liveReport.signed) {
    throw 'live_signed_verification_failed'
}
$passed++
Write-Host 'PASS existing Windows signed executable'

$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
[void][System.IO.Directory]::CreateDirectory($temporary)
$first = Join-Path $temporary 'fixture[1].txt'
$second = Join-Path $temporary 'fixture[2].txt'
[System.IO.File]::WriteAllText($first, 'unsigned Authenticode test fixture')
[System.IO.File]::WriteAllText($second, 'unsigned Authenticode test fixture')
try {
    $realUnsigned = & $Verifier -Path $first | ConvertFrom-Json
    if ($realUnsigned.signed -or $realUnsigned.status -cne 'NotSigned') {
        throw 'live_unsigned_verification_failed'
    }
    $passed++
    Write-Host 'PASS existing unsigned policy and literal bracket path'

    $approved = 'a' * 64
    $other = 'b' * 64
    $certificate = [pscustomobject]@{
        Subject = 'CN=PUBLIC TEST METADATA ONLY'
        Thumbprint = 'C' * 40
        NotAfter = [DateTime]::UtcNow.AddDays(1)
        PublicHash = $approved
    }
    $certificate | Add-Member -MemberType ScriptMethod -Name GetCertHashString -Value {
        param($algorithm)
        if ($algorithm -ne [System.Security.Cryptography.HashAlgorithmName]::SHA256) {
            throw 'certificate_hash_algorithm_changed'
        }
        $this.PublicHash
    }
    $timestamp = [pscustomobject]@{ Subject = 'CN=PUBLIC TIMESTAMP TEST METADATA ONLY' }
    function New-TestSignature {
        param([string]$Status, $Certificate, $Timestamp)
        [pscustomobject]@{
            Status = [System.Management.Automation.SignatureStatus]::$Status
            SignerCertificate = $Certificate
            TimeStamperCertificate = $Timestamp
        }
    }
    $global:AuthTestSignature = New-TestSignature 'Valid' $certificate $timestamp
    $global:AuthTestCalls = [System.Collections.Generic.List[string]]::new()
    $global:AuthTestThrow = $false
    $global:AuthTestSecond = $null
    function global:Get-AuthenticodeSignature {
        param([string]$LiteralPath)
        $global:AuthTestCalls.Add($LiteralPath)
        if ($global:AuthTestThrow) { throw 'provider_verification_failed' }
        if ($null -ne $global:AuthTestSecond -and $global:AuthTestCalls.Count -eq 2) {
            return $global:AuthTestSecond
        }
        $global:AuthTestSignature
    }
    function Test-Case {
        param([string]$Name, [hashtable]$Arguments, [string]$ExpectedError = '')
        $global:AuthTestCalls.Clear()
        $output = [System.Collections.Generic.List[object]]::new()
        $caught = ''
        try {
            & $Verifier @Arguments | ForEach-Object { $output.Add($_) }
        } catch { $caught = $_.Exception.Message }
        if ($ExpectedError) {
            if (-not $caught.StartsWith($ExpectedError, [StringComparison]::Ordinal)) {
                throw "case_failed:${Name}:expected=${ExpectedError}:actual=$caught"
            }
            if ($output.Count -ne 0) { throw "partial_success_output:${Name}" }
        } else {
            if ($caught) { throw "case_failed:${Name}:$caught" }
            $report = ($output -join [Environment]::NewLine) | ConvertFrom-Json
            if (@($report).Count -ne @($Arguments.Path).Count) {
                throw "report_count_changed:${Name}"
            }
        }
        Write-Host "PASS $Name"
    }
    Test-Case 'valid approved timestamped' @{Path=$first;Required=$true;RequireTimestamp=$true;ExpectedSignerSha256=$approved}
    $passed++
    Test-Case 'normalized uppercase signer with spaces' @{Path=$first;Required=$true;ExpectedSignerSha256=(' '+$approved.ToUpperInvariant()+' ')}
    $passed++
    Test-Case 'unapproved signer' @{Path=$first;Required=$true;ExpectedSignerSha256=$other} 'authenticode_unapproved_signer:'
    $passed++
    foreach ($badPin in @('', ' ', ('a'*63), ('a'*65), ('g'*64))) {
        Test-Case 'malformed or empty explicit signer pin' @{Path=$first;ExpectedSignerSha256=$badPin} 'authenticode_expected_signer_sha256_invalid'
        if ($global:AuthTestCalls.Count -ne 0) { throw 'pin_validation_was_not_first' }
        $passed++
    }
    $global:AuthTestSignature = New-TestSignature 'Valid' $certificate $null
    Test-Case 'missing required timestamp' @{Path=$first;Required=$true;RequireTimestamp=$true} 'authenticode_timestamp_required_but_missing:'
    $passed++
    Test-Case 'timestamp remains optional without switch' @{Path=$first;Required=$true}
    $passed++
    $global:AuthTestSignature = New-TestSignature 'NotSigned' $null $null
    Test-Case 'unsigned rejected when required' @{Path=$first;Required=$true} 'authenticode_required_but_missing:'
    $passed++
    Test-Case 'unsigned rejected when pinned' @{Path=$first;ExpectedSignerSha256=$approved} 'authenticode_unapproved_signer:'
    $passed++
    Test-Case 'unsigned rejected when timestamp required' @{Path=$first;RequireTimestamp=$true} 'authenticode_timestamp_required_but_missing:'
    $passed++
    foreach ($status in @('HashMismatch','NotTrusted','UnknownError','NotSupportedFileFormat','Incompatible')) {
        foreach ($cert in @($certificate, $null)) {
            $global:AuthTestSignature = New-TestSignature $status $cert $null
            Test-Case "invalid $status certificate=$($null -ne $cert)" @{Path=$first} 'authenticode_present_but_invalid:'
            $passed++
        }
    }
    $global:AuthTestSignature = New-TestSignature 'Valid' $null $timestamp
    Test-Case 'inconsistent valid status without signer' @{Path=$first} 'authenticode_present_but_invalid:'
    $passed++
    $global:AuthTestSignature = New-TestSignature 'NotSigned' $certificate $null
    Test-Case 'inconsistent unsigned status with signer' @{Path=$first} 'authenticode_present_but_invalid:'
    $passed++
    Test-Case 'missing literal file' @{Path=(Join-Path $temporary 'absent.exe');Required=$true} 'authenticode_path_missing:'
    if ($global:AuthTestCalls.Count -ne 0) { throw 'missing_path_reached_provider' }
    $passed++
    $global:AuthTestThrow = $true
    Test-Case 'provider error propagates' @{Path=$first;Required=$true} 'provider_verification_failed'
    $passed++
    $global:AuthTestThrow = $false
    $global:AuthTestSignature = New-TestSignature 'Valid' $certificate $timestamp
    $global:AuthTestSecond = New-TestSignature 'HashMismatch' $certificate $timestamp
    Test-Case 'multi-file failure emits no partial report' @{Path=@($first,$second,$liveSigned);Required=$true} 'authenticode_present_but_invalid:'
    if ($global:AuthTestCalls.Count -ne 2) { throw 'verification_continued_after_failure' }
    $passed++
    $global:AuthTestSecond = $null
    Test-Case 'multi-file success' @{Path=@($first,$second);Required=$true}
    $passed++
} finally {
    Remove-Item Function:\Get-AuthenticodeSignature -ErrorAction SilentlyContinue
    foreach ($name in @('AuthTestSignature','AuthTestCalls','AuthTestThrow','AuthTestSecond')) {
        Remove-Variable -Name $name -Scope Global -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
# A real child process must fail with a nonzero exit when Required rejects unsigned data.
$processFixture = Join-Path ([System.IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N')+'.txt')
[System.IO.File]::WriteAllText($processFixture, 'unsigned process exit fixture')
try {
    $engine = (Get-Process -Id $PID).Path
    $ErrorActionPreference = 'Continue'
    & $engine -NoLogo -NoProfile -NonInteractive -File $Verifier -Path $processFixture -Required *> $null
    $childExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($childExit -eq 0) { throw 'required_failure_exit_code_zero' }
    $passed++
    Write-Host 'PASS real child process nonzero exit'
} finally {
    Remove-Item -LiteralPath $processFixture -Force
}
Write-Host "AUTHENTICODE_TESTS_PASSED=$passed"
