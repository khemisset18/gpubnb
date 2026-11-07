#Requires -Version 5.1
# Recovery deliberately requires the same explicit maintenance scope as installation.
# The journal is evidence of intent, never permission to stop a real service.
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'stage4-windows-path-policy.ps1')

function Assert-Stage4JournalPath([string]$Path) {
    $node=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    while($null -ne $node) {
        if (($node.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'stage4_journal_reparse_forbidden'
        }
        $node=if($node -is [IO.DirectoryInfo]){$node.Parent}else{$node.Directory}
    }
}

function Write-Stage4TransactionJournal([string]$Target,$Journal) {
    $path=Join-Path $Target '.stage4-transaction.json'
    $pending=Join-Path $Target '.stage4-transaction.pending'
    $previous=Join-Path $Target '.stage4-transaction.previous'
    foreach($file in @($path,$pending,$previous)) {
        if(Test-Path -LiteralPath $file) { Assert-Stage4JournalPath $file }
    }
    $bytes=[Text.Encoding]::UTF8.GetBytes(($Journal | ConvertTo-Json -Depth 8 -Compress))
    $stream=[IO.FileStream]::new($pending,[IO.FileMode]::Create,[IO.FileAccess]::Write,
        [IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) }
    finally { $stream.Dispose() }
    if(Test-Path -LiteralPath $path) { [IO.File]::Replace($pending,$path,$previous) }
    else { [IO.File]::Move($pending,$path) }
}

function Open-Stage4MaintenanceLock([string]$Target) {
    $path=Join-Path $Target '.gpubnb-maintenance.lock'
    if(Test-Path -LiteralPath $path) { Assert-Stage4JournalPath $path }
    return [IO.File]::Open($path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
}

function Invoke-Stage4FourFileRecovery {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$TargetDirectory,
        [Parameter(Mandatory=$true)][scriptblock]$StopControlledService,
        [Parameter(Mandatory=$true)][scriptblock]$StartControlledService,
        [Parameter(Mandatory=$true)][scriptblock]$IsControlledServiceRunning,
        [Parameter(Mandatory=$true)][scriptblock]$IsControlledServiceStopped,
        [Parameter(Mandatory=$true)][scriptblock]$ValidateControlledRuntime,
        [string]$MaintenanceToken='',
        [scriptblock]$RecoveryCheckpoint={param($step)}
    )
    $ErrorActionPreference='Stop'
    $target=Get-Stage4CanonicalWindowsPath -Path $TargetDirectory
    $temp=Get-Stage4CanonicalWindowsPath -Path $env:TEMP
    $fixture=($target.StartsWith($temp+'\GPUbnb-stage4-maintenance-test-',[StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf (Split-Path -Parent $target)) -cmatch '^GPUbnb-stage4-maintenance-test-[a-f0-9]{32}$' -and
        (Split-Path -Leaf $target) -ceq 'installed')
    $physical=($target -ieq 'C:\Program Files\GPUbnb' -and
        $MaintenanceToken -ceq 'STAGE4-PHYSICAL-MAINTENANCE-AUTHORIZED-BY-PREFLIGHT' -and
        -not $PSBoundParameters.ContainsKey('RecoveryCheckpoint'))
    if($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess -or -not ($fixture -or $physical)) {
        throw 'stage4_recovery_unapproved_path'
    }
    Assert-Stage4JournalPath $target
    $lock=Open-Stage4MaintenanceLock $target
    try {
        $path=Join-Path $target '.stage4-transaction.json'
        Assert-Stage4JournalPath $path
        if((Get-Item -LiteralPath $path).Length -gt 65536) {throw 'stage4_recovery_journal_too_large'}
        $journal=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        $names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe','gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
        if($journal.version -ne 2 -or $journal.target -cne $target -or
            $journal.tag -cnotmatch '^[a-f0-9]{32}$' -or
            $journal.oldAgentCommit -cnotmatch '^[0-9a-f]{40}$' -or
            $journal.newAgentCommit -cnotmatch '^[0-9a-f]{40}$' -or
            $journal.phase -cnotin @('PREPARED','REPLACING','VALIDATING','RESTORING','COMMITTED','ROLLED_BACK') -or
            @($journal.files).Count -ne 4) {throw 'stage4_recovery_journal_invalid'}
        $seen=@{};$restore=@{}
        # Validate ALL candidates before the first service or file mutation.
        foreach($pin in $journal.files) {
            $name=[string]$pin.name
            if($name -cnotin $names -or $seen.ContainsKey($name) -or
                $pin.oldHash -cnotmatch '^[0-9A-Fa-f]{64}$' -or
                $pin.newHash -cnotmatch '^[0-9A-Fa-f]{64}$' -or
                [string]::IsNullOrWhiteSpace($pin.sddl)) {throw 'stage4_recovery_pin_invalid'}
            $seen[$name]=$true
            $live=Join-Path $target $name
            $backup=Join-Path $target ('.stage4-'+$journal.tag+'.old.'+$name)
            $source=if($journal.phase -ceq 'COMMITTED'){$live}elseif(Test-Path -LiteralPath $backup){$backup}else{$live}
            Assert-Stage4JournalPath $source
            $expected=if($journal.phase -ceq 'COMMITTED'){$pin.newHash}else{$pin.oldHash}
            if((Get-Item -LiteralPath $source).PSIsContainer -or
                (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ine $expected -or
                (Get-Acl -LiteralPath $source).Sddl -cne $pin.sddl) {throw 'stage4_recovery_pin_mismatch'}
            if(Test-Path -LiteralPath $live) { Assert-Stage4JournalPath $live }
            $failed=Join-Path $target ('.stage4-'+$journal.tag+'.failed.'+$name)
            if(Test-Path -LiteralPath $failed) { Assert-Stage4JournalPath $failed }
            $restore[$name]=$source
        }
        # Every non-COMMITTED phase is a rollback candidate. REPLACING may
        # have only half the renames complete; VALIDATING may have all new
        # files live; RESTORING may itself be partially applied after a crash.
        # Validate all pinned recovery sources above, stop the service, then
        # idempotently restore each old component from its verified backup.
        if($journal.phase -cne 'COMMITTED') {
            if(-not (& $IsControlledServiceStopped)) { & $StopControlledService }
            if(-not (& $IsControlledServiceStopped)) {throw 'stage4_recovery_stop_unconfirmed'}
            & $RecoveryCheckpoint 'recovery-stopped'
            foreach($pin in $journal.files) {
                $name=[string]$pin.name;$live=Join-Path $target $name
                if($restore[$name] -cne $live) {
                    $liveIsOld=$false
                    if(Test-Path -LiteralPath $live) {
                        $liveEntry=Get-Item -LiteralPath $live -Force
                        if($liveEntry.PSIsContainer -or
                            (Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash -ine $pin.oldHash -or
                            (Get-Acl -LiteralPath $live).Sddl -cne $pin.sddl) {
                            # Preserve an unexpected/new component for evidence.
                            # A unique same-directory rename is atomic and keeps
                            # the original ACL; no security descriptor is rebuilt.
                            $failed=Join-Path $target ('.stage4-'+$journal.tag+'.recovery-failed-'+[Guid]::NewGuid().ToString('N')+'.'+$name)
                            if(Test-Path -LiteralPath $failed) {Assert-Stage4JournalPath $failed}
                            Move-Item -LiteralPath $live -Destination $failed
                            & $RecoveryCheckpoint ('recovery-removed-'+$name)
                        } else { $liveIsOld=$true }
                    }
                    if(-not $liveIsOld) {
                        # Consume the already verified old backup by same-parent
                        # rename. If recovery crashes after this move, the next
                        # run verifies the now-live old file as its source.
                        Move-Item -LiteralPath $restore[$name] -Destination $live
                        & $RecoveryCheckpoint ('recovery-restored-'+$name)
                    }
                }
            }
        }
        foreach($pin in $journal.files) {
            $live=Join-Path $target $pin.name
            $expected=if($journal.phase -ceq 'COMMITTED'){$pin.newHash}else{$pin.oldHash}
            if((Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash -ine $expected -or
                (Get-Acl -LiteralPath $live).Sddl -cne $pin.sddl) {throw 'stage4_recovery_final_pin_mismatch'}
        }
        if(-not (& $IsControlledServiceRunning)) { & $StartControlledService }
        $runtimeHealthy=(& $IsControlledServiceRunning) -and (& $ValidateControlledRuntime)
        if(-not $runtimeHealthy) {
            if(-not (& $IsControlledServiceStopped)) {
                & $StopControlledService
                if(-not (& $IsControlledServiceStopped)) {throw 'stage4_recovery_unhealthy_service_stop_not_confirmed'}
            }
            throw 'stage4_recovery_runtime_unhealthy'
        }
        if($journal.phase -cne 'COMMITTED') {$journal.phase='ROLLED_BACK';Write-Stage4TransactionJournal $target $journal}
        return [pscustomobject]@{kind='STAGE4_DURABLE_RECOVERY';phase=$journal.phase;isTemporaryFixture=$fixture;powerLossProven=$false}
    } finally { $lock.Dispose() }
}
