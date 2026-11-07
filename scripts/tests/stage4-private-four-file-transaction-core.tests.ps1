#Requires -Version 5.1
# Execute the same production swap core with TEMP-only fixtures and fake service.
# No certificate trust, Program Files writes, service, Render or hardware use.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'stage4-private-four-file-transaction-core.ps1')
# Regression for the PC1 incident: SIX PASSED checks must be accepted.
# The former wrapper erroneously required SIX failures. Exercise the real
# shared gate against synthetic data with no service or filesystem mutation.
$namesExpected=@(
    'nonoverlapping-real-folders',
    'new-package-complete-signed-pinned',
    'old-backup-hashes-signatures-acls',
    'machine-context-publisher-chain',
    'known-service-process-topology',
    'expected-gpu-uuid'
)
$good=[pscustomobject]@{
    kind='STAGE4_PC1_PRIVATE_INSTALL_READINESS_READONLY'
    localPreflightPassed=$true
    installAuthorized=$false
    checks=@($namesExpected | ForEach-Object {
        [pscustomobject]@{name=$_;passed=$true;detail='fixture'}
    })
}
if(-not (Assert-Stage4MaintenanceReadiness -Readiness $good)) {
    throw 'stage4_readiness_all_six_true_rejected'
}
Write-Host 'PASS real readiness gate accepts six TRUE results'

function Test-ReadinessReject {
    param([string]$Label,[scriptblock]$Mutate)
    $report=(ConvertTo-Json -InputObject $good -Depth 10 | ConvertFrom-Json)
    & $Mutate $report
    $blocked=$false
    try { [void](Assert-Stage4MaintenanceReadiness -Readiness $report) }
    catch { $blocked=$true }
    if(-not $blocked) { throw ('stage4_readiness_missing_rejection:'+$Label) }
    Write-Host ('PASS fail-closed readiness '+$Label)
}
Test-ReadinessReject 'one failed check' {param($r)$r.checks[3].passed=$false}
Test-ReadinessReject 'all six failed' {param($r)foreach($c in $r.checks){$c.passed=$false}}
Test-ReadinessReject 'duplicate named check' {param($r)$r.checks[5].name=$r.checks[0].name}
Test-ReadinessReject 'unknown named check' {param($r)$r.checks[5].name='fake-check'}
Test-ReadinessReject 'missing named check' {param($r)$r.checks=@($r.checks | Select-Object -First 5)}
Test-ReadinessReject 'extra named check' {param($r)$r.checks+=@([pscustomobject]@{name='extra';passed=$true})}
Test-ReadinessReject 'nonboolean passed string' {param($r)$r.checks[1].passed='True'}
Test-ReadinessReject 'overall preflight false' {param($r)$r.localPreflightPassed=$false}
Test-ReadinessReject 'install already authorized' {param($r)$r.installAuthorized=$true}
Test-ReadinessReject 'wrong report kind' {param($r)$r.kind='WRONG_KIND'}

$maintenance=Join-Path (Split-Path -Parent $PSScriptRoot) 'stage4-private-four-file-maintenance.ps1'
$recovery=Join-Path (Split-Path -Parent $PSScriptRoot) 'stage4-private-four-file-recover.ps1'
$tokens=$null;$parseErrors=$null
[void][Management.Automation.Language.Parser]::ParseFile($maintenance,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0) {
    throw ('stage4_maintenance_wrapper_parser_error:'+$parseErrors[0].Message)
}
$recoveryTokens=$null;$recoveryParseErrors=$null
[void][Management.Automation.Language.Parser]::ParseFile($recovery,[ref]$recoveryTokens,[ref]$recoveryParseErrors)
if($recoveryParseErrors.Count -ne 0) {
    throw ('stage4_recovery_wrapper_parser_error:'+$recoveryParseErrors[0].Message)
}
$maintenanceSource=Get-Content -LiteralPath $maintenance -Raw
if($maintenanceSource -notmatch '\[switch\]\$Apply' -or
    $maintenanceSource -notmatch '\[switch\]\$OperatorPresentAndApproved' -or
    $maintenanceSource -notmatch 'stage4_maintenance_exact_live_service_identity_failed' -or
    $maintenanceSource -notmatch 'stage4_maintenance_local_claim_runtime_scope_changed' -or
    $maintenanceSource -notmatch 'Assert-Stage4MaintenanceReadiness' -or
    $maintenanceSource -notmatch 'stage4ServiceStartUtc' -or
    $maintenanceSource -notmatch 'heartbeat' -or
    $maintenanceSource -notmatch 'serverAccepted' -or
    $maintenanceSource -notmatch 'OldAgentCommit' -or
    $maintenanceSource -notmatch '\[int\]\$eventProcessId -ne \[int\]\$service\.ProcessId' -or
    $maintenanceSource -notmatch 'pinnedLegacyHeartbeatAfterStart' -or
    $maintenanceSource -notmatch 'stage4CounterBeforeStart' -or
    $maintenanceSource -notmatch 'stage4_maintenance_explicit_operator_approval_required') {
    throw 'stage4_maintenance_wrapper_required_safety_check_missing'
}
Write-Host 'PASS real wrapper parse and fail-closed preflight/consent/heartbeat policy'
$recoverySource=Get-Content -LiteralPath $recovery -Raw
if($recoverySource -notmatch '\[switch\]\$Recover' -or
    $recoverySource -notmatch '\[switch\]\$OperatorPresentAndApproved' -or
    $recoverySource -notmatch 'stage4_recovery_machine_identity_mismatch' -or
    $recoverySource -notmatch 'oldAgentCommit' -or
    $recoverySource -notmatch 'newAgentCommit' -or
    $recoverySource -notmatch 'serverAccepted' -or
    $recoverySource -notmatch 'processId' -or
    $recoverySource -notmatch 'Invoke-Stage4FourFileRecovery' -or
    $recoverySource -notmatch 'ValidateControlledRuntime') {
    throw 'stage4_recovery_wrapper_required_safety_check_missing'
}
Write-Host 'PASS separate explicit crash-recovery entry point parses and remains fail closed'

# The same fresh-process proof invoked by the real physical wrapper.
$startUtc=[DateTime]::UtcNow.AddMinutes(-1)
$validProof=@{
    ServiceStartUtc=$startUtc
    ProcessCreationUtc=$startUtc.AddSeconds(1)
    InitialProcessId=1337
    FinalProcessId=1337
    InitialFileHash=('a'*64)
    FinalFileHash=('a'*64)
    OldPinnedHash=('b'*64)
    NewPinnedHash=('a'*64)
}
if (-not (Test-Stage4NewProcessProof @validProof)) {
    throw 'stage4_fresh_process_proof_positive_refused'
}
function Expect-ProcessProofRejection([string]$Label,[scriptblock]$Mutate) {
    $proof=@{};foreach($key in $validProof.Keys){$proof[$key]=$validProof[$key]}
    & $Mutate $proof
    if (Test-Stage4NewProcessProof @proof) {
        throw ('stage4_fresh_process_proof_not_rejected:'+$Label)
    }
    Write-Host ('PASS reject stale process evidence '+$Label)
}
Expect-ProcessProofRejection 'wrong PID' {param($p)$p.FinalProcessId=1338}
Expect-ProcessProofRejection 'PID missing' {param($p)$p.InitialProcessId=0}
Expect-ProcessProofRejection 'pre-existing stale service' {param($p)$p.ProcessCreationUtc=$p.ServiceStartUtc.AddMinutes(-1)}
Expect-ProcessProofRejection 'file replaced after heartbeat' {param($p)$p.FinalFileHash=('c'*64)}
Expect-ProcessProofRejection 'unpinned executable' {param($p)$p.InitialFileHash=('d'*64);$p.FinalFileHash=('d'*64)}
Expect-ProcessProofRejection 'invalid executable hash' {param($p)$p.InitialFileHash='not-sha256';$p.FinalFileHash='not-sha256'}
Write-Host 'PASS fresh LocalSystem process and pinned binary health proof policy'

$names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe',
    'gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')

function Run-Case {
    param([string]$Title,[int]$FailAfter=0,[bool]$BadHealth=$false,
        [bool]$FailStartOnce=$false,[bool]$ExpectRollback=$false,
        [bool]$BadOldHash=$false,[int]$FailDuringStaging=0,
        [bool]$ExpectRollbackUnhealthy=$false,[bool]$FailNewHealthOnly=$false,
        [bool]$OrphanTransaction=$false)
    $root=Join-Path $env:TEMP ('GPUbnb-stage4-maintenance-test-'+[Guid]::NewGuid().ToString('N'))
    $candidate=Join-Path $root 'candidate'
    $target=Join-Path $root 'installed'
    [void](New-Item -ItemType Directory -Path $candidate -Force)
    [void](New-Item -ItemType Directory -Path $target -Force)
    $oldHashes=@{};$newHashes=@{};$oldSddl=@{}
    foreach($name in $names) {
        $oldFile=Join-Path $target $name
        $newFile=Join-Path $candidate $name
        [IO.File]::WriteAllText($oldFile,('real-original-for-test-'+$name))
        [IO.File]::WriteAllText($newFile,('new-replacement-for-test-'+$name))
        $oldHashes[$name]=(Get-FileHash -LiteralPath $oldFile -Algorithm SHA256).Hash
        $newHashes[$name]=(Get-FileHash -LiteralPath $newFile -Algorithm SHA256).Hash
        $oldSddl[$name]=(Get-Acl -LiteralPath $oldFile).Sddl
    }
    if($BadOldHash){$oldHashes[$names[0]]=('0'*64)}
    if($OrphanTransaction) {
        [IO.File]::WriteAllText((Join-Path $target ('.stage4-'+([Guid]::NewGuid().ToString('N'))+'.old.'+$names[0])),'unreconciled-backup')
    }
    $script:stage4FakeRunning=$true
    $script:stage4FakeStartFailures=if($FailStartOnce){1}else{0}
    $script:stage4FakeStopCalls=0
    $script:stage4HealthCalls=0
    $stop={
        $script:stage4FakeStopCalls++
        $script:stage4FakeRunning=$false
    }
    $start={
        if($script:stage4FakeStartFailures -gt 0) {
            $script:stage4FakeStartFailures--
            throw 'stage4_test_injected_start_failure'
        }
        $script:stage4FakeRunning=$true
    }
    $running={ return $script:stage4FakeRunning }
    $stopped={ return (-not $script:stage4FakeRunning) }
    $health={
        $script:stage4HealthCalls++
        return (-not $BadHealth -and (-not $FailNewHealthOnly -or $script:stage4HealthCalls -ge 2))
    }
    $args=@{
        TargetDirectory=$target
        CandidateDirectory=$candidate
        OldHashes=$oldHashes
        NewHashes=$newHashes
        OldSddl=$oldSddl
        OldAgentCommit=('a'*40)
        NewAgentCommit=('b'*40)
        StopControlledService=$stop
        StartControlledService=$start
        IsControlledServiceRunning=$running
        IsControlledServiceStopped=$stopped
        ValidateControlledRuntime=$health
        InjectFailureAfter=$FailAfter
        InjectStageFailureAfter=$FailDuringStaging
    }
    try {
        $response=$null
        $errorText=$null
        try { $response=Invoke-Stage4FourFileTransactionCore @args }
        catch { $errorText=$_.Exception.Message }
        if(-not $script:stage4FakeRunning -and -not $ExpectRollbackUnhealthy) {
            throw ('stage4_test_service_not_recovered:'+$Title)
        }
        if($ExpectRollbackUnhealthy -and $script:stage4FakeRunning) {
            throw ('stage4_test_unhealthy_restored_agent_left_running:'+$Title)
        }
        if($ExpectRollback -or $ExpectRollbackUnhealthy) {
            $expectedPrefix=if($ExpectRollbackUnhealthy){
                'stage4_core_ROLLBACK_FAILED:*:stage4_core_rollback_runtime_unhealthy'
            }else{
                'stage4_core_ROLLBACK_VERIFIED:*'
            }
            if($null -eq $errorText -or $errorText -notlike $expectedPrefix) {
                throw ('stage4_test_rollback_health_incorrect:'+$Title+':'+$errorText)
            }
            foreach($name in $names){
                $path=Join-Path $target $name
                if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $oldHashes[$name] -or
                    (Get-Acl -LiteralPath $path).Sddl -cne $oldSddl[$name]){
                    throw ('stage4_test_original_hash_acl_not_restored:'+$Title+':'+$name)
                }
            }
            Write-Host ('PASS rollback old four hashes and SDDL '+$Title)
        } elseif($OrphanTransaction) {
            if($null -eq $errorText -or
                $errorText -cne 'stage4_core_unreconciled_transaction_requires_independent_recovery' -or
                $script:stage4FakeStopCalls -ne 0) {
                throw ('stage4_test_recovery_barrier_bypassed:'+$Title+':'+$errorText)
            }
            foreach($name in $names) {
                $original=Join-Path $target $name
                if((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash -ine $oldHashes[$name] -or
                    (Get-Acl -LiteralPath $original).Sddl -cne $oldSddl[$name]) {
                    throw ('stage4_test_recovery_barrier_modified_original:'+$name)
                }
            }
            Write-Host ('PASS unreconciled transaction blocks service stop '+$Title)
        } elseif($BadOldHash) {
            if($null -eq $errorText -or
                $errorText -notlike 'stage4_core_input_drift:*' -or
                $script:stage4FakeStopCalls -ne 0) {
                throw 'stage4_test_bad_preflight_mutated_service'
            }
            Write-Host ('PASS reject drift without stop '+$Title)
        } elseif($FailDuringStaging -gt 0) {
            if($null -eq $errorText -or
                $errorText -notlike 'stage4_core_pre_stop_cleanup_verified:*' -or
                $script:stage4FakeStopCalls -ne 0) {
                throw ('stage4_test_pre_stop_cleanup_or_service_failure:'+$Title+':'+$errorText)
            }
            foreach($name in $names) {
                $live=Join-Path $target $name
                if((Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash -ine $oldHashes[$name] -or
                    (Get-Acl -LiteralPath $live).Sddl -cne $oldSddl[$name]) {
                    throw ('stage4_test_pre_stop_original_changed:'+$Title+':'+$name)
                }
            }
            if(@(Get-ChildItem -LiteralPath $target -Force |
                Where-Object { $_.Name -like '.stage4-*' }).Count -ne 0) {
                throw ('stage4_test_pre_stop_staged_files_remain:'+$Title)
            }
            Write-Host ('PASS interrupted pre-stop staging cleaned without service stop '+$Title)
        } else {
            if($null -ne $errorText -or $response.kind -ne 'STAGE4_PRIVATE_FOUR_FILE_TRANSACTION' -or
                $response.isTemporaryFixture -cne $true -or
                $response.actualPC1Touched -cne $false -or
                $response.publicBookabilityEnabled -cne $false -or
                $response.quarantineModified -cne $false) {
                throw ('stage4_test_nominal_failed:'+$Title+':'+$errorText)
            }
            foreach($name in $names) {
                $live=Join-Path $target $name
                if((Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash -ine $newHashes[$name] -or
                    (Get-Acl -LiteralPath $live).Sddl -cne $oldSddl[$name]) {
                    throw ('stage4_test_new_hash_acl_wrong:'+$Title+':'+$name)
                }
            }
            if(@($response.backupFiles | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -ne 0) {
                throw 'stage4_test_old_originals_not_retained'
            }
            Write-Host ('PASS 4-file replacement with ACLs and saved originals '+$Title)
        }
    } finally {
        Remove-Item -LiteralPath $root -Force -Recurse -ErrorAction Stop
    }
}

Run-Case -Title 'normal-success'
Run-Case -Title 'orphan_transaction_blocks_next_swap' -OrphanTransaction $true
foreach($i in 1..4){
    Run-Case -Title ('pre_stop_staging_failure_'+$i) -FailDuringStaging $i
}
foreach($i in 1..4){
    Run-Case -Title ('failure_after_'+$i) -FailAfter $i -ExpectRollback $true
}
Run-Case -Title 'failed_post_start_health_old_agent_still_unhealthy' -BadHealth $true -ExpectRollbackUnhealthy $true
Run-Case -Title 'failed_new_agent_health_old_agent_healthy' -FailNewHealthOnly $true -ExpectRollback $true
Run-Case -Title 'first_service_start_failed' -FailStartOnce $true -ExpectRollback $true
Run-Case -Title 'pinned_hash_drift' -BadOldHash $true

$refused=$false
try {
    $args=@{
        TargetDirectory='C:\Program Files\GPUbnb'
        CandidateDirectory='C:\Users\Public'
        OldHashes=@{};NewHashes=@{};OldSddl=@{};OldAgentCommit=('a'*40);NewAgentCommit=('b'*40)
        StopControlledService={throw 'must_not_stop'}
        StartControlledService={throw 'must_not_start'}
        IsControlledServiceRunning={$true}
        IsControlledServiceStopped={$true}
        ValidateControlledRuntime={$true}
    }
    Invoke-Stage4FourFileTransactionCore @args | Out-Null
}catch{ $refused=$_.Exception.Message -eq 'stage4_core_rejects_unapproved_install_path' }
if(-not $refused) {throw 'stage4_core_real_path_not_rejected_without_scope'}
Write-Host 'PASS production target rejected without maintenance authorization token'
