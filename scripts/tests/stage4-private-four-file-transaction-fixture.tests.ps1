#Requires -Version 5.1
# All writes are under fresh $env:TEMP. Synthetic service callbacks only.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'stage4-private-four-file-transaction-fixture.ps1')
$names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe',
    'gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')

function New-Fixture {
    $root=Join-Path $env:TEMP ('GPUbnb-stage4-transaction-test-'+[Guid]::NewGuid().ToString('N'))
    $candidate=Join-Path $root 'candidate'
    $installed=Join-Path $root 'installed'
    [void](New-Item -ItemType Directory -Path $candidate -Force)
    [void](New-Item -ItemType Directory -Path $installed -Force)
    foreach($name in $names) {
        [IO.File]::WriteAllText((Join-Path $candidate $name),('NEW test data '+$name))
        [IO.File]::WriteAllText((Join-Path $installed $name),('ORIGINAL test data '+$name))
    }
    return $root
}

function Invoke-TestCase {
    param([string]$Title,[int]$FailAfterFile=0,[bool]$BadHealth=$false,
        [bool]$FailStartOnce=$false,[bool]$ExpectRollback=$false)
    $root=New-Fixture
    $installed=Join-Path $root 'installed'
    $script:running=$true
    $script:startFailuresRemaining=if($FailStartOnce){1}else{0}
    $script:badHealth=$BadHealth
    $stop={ $script:running=$false }
    $start={
        if($script:startFailuresRemaining -gt 0){
            $script:startFailuresRemaining--
            throw 'injected_fake_service_start_failed'
        }
        $script:running=$true
    }
    $running={ return $script:running }
    $stopped={ return (-not $script:running) }
    $health={ return (-not $script:badHealth) }
    $old=@{}
    foreach($name in $names) {
        $path=Join-Path $installed $name
        $old[$name]=@{
            hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
            sddl=(Get-Acl -LiteralPath $path).Sddl
        }
    }
    try {
        $errorText=$null
        $res=$null
        try {
            $args=@{
                FixtureRoot=$root
                StopFakeService=$stop
                StartFakeService=$start
                IsFakeRunning=$running
                IsFakeStopped=$stopped
                CheckFakeHealth=$health
                FailAfterFile=$FailAfterFile
            }
            $res=Invoke-Stage4TemporaryTransaction @args
        }catch{ $errorText=$_.Exception.Message }
        if(-not $script:running) { throw ("fixture_service_not_running_after_test:"+$Title) }
        if ($ExpectRollback) {
            if ($null -eq $errorText -or $errorText -notlike 'stage4_fixture_rollback_verified:*') {
                throw ("fixture_expected_successful_rollback:"+$Title+":"+$errorText)
            }
            foreach($name in $names) {
                $path=Join-Path $installed $name
                if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $old[$name].hash -or
                    (Get-Acl -LiteralPath $path).Sddl -cne $old[$name].sddl) {
                    throw ("fixture_originals_not_restored:"+$Title+":"+$name)
                }
            }
            Write-Host "PASS rollback $Title with original four hashes and four SDDL"
        } else {
            if($null -ne $errorText) { throw ("fixture_unexpected_error:"+$Title+":"+$errorText) }
            if ($res.kind -cne 'STAGE4_TEMPORARY_TRANSACTION_SIMULATOR' -or
                $res.fixtureOnly -cne $true -or $res.actualServiceRollbackTested -cne $false -or
                $res.installationAuthorized -cne $false -or $res.realPC1Modified -cne $false) {
                throw ("fixture_report_claims_real_maintenance:"+$Title)
            }
            foreach($name in $names) {
                $path=Join-Path $installed $name
                $expected=(Get-FileHash -LiteralPath (Join-Path (Join-Path $root 'candidate') $name) -Algorithm SHA256).Hash
                if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $expected) {
                    throw ("fixture_candidate_not_installed:"+$Title+":"+$name)
                }
            }
            $backups=@(Get-ChildItem -LiteralPath $installed -File -Filter '.stage4-*.old.*')
            if ($backups.Count -ne 4) { throw 'fixture_original_copies_missing_after_success' }
            Write-Host "PASS success $Title with exact four new hashes and four original backups"
        }
    }
    finally {
        Remove-Item -LiteralPath $root -Force -Recurse
    }
}

Invoke-TestCase -Title 'all-four-files'
foreach($number in 1..4) {
    Invoke-TestCase -Title "injected-partial-$number" -FailAfterFile $number -ExpectRollback $true
}
Invoke-TestCase -Title 'unhealthy-after-restart' -BadHealth $true -ExpectRollback $true
Invoke-TestCase -Title 'fake-start-failed-once' -FailStartOnce $true -ExpectRollback $true

$reject=$false
try {
    $args=@{
        FixtureRoot=(Join-Path $env:ProgramFiles 'GPUbnb')
        StopFakeService={throw 'must-not-stop-real-service'}
        StartFakeService={throw 'must-not-start-real-service'}
        IsFakeRunning={$true}
        IsFakeStopped={$true}
        CheckFakeHealth={$true}
    }
    Invoke-Stage4TemporaryTransaction @args | Out-Null
} catch { $reject=$_.Exception.Message -eq 'stage4_fixture_refuses_real_installation' }
if (-not $reject) { throw 'fixture_did_not_reject_real_program_files' }
Write-Host 'PASS refuse Program Files and real service mutation'
