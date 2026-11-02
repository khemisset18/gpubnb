#Requires -Version 5.1
# Recovery deliberately requires the same explicit maintenance scope as installation.
# The journal is evidence of intent, never permission to stop a real service.
Set-StrictMode -Version Latest

function Assert-Stage4JournalPath([string]$Path) {
    $node=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    while($null -ne $node) {
        if (($node.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'stage4_journal_reparse_forbidden'
        }
        $node=if($node.PSIsContainer){$node.Parent}else{$node.Directory}
    }
}

function Write-Stage4TransactionJournal([string]$Target,$Journal) {
    $path=Join-Path $Target '.stage4-transaction.json'
    $pending=Join-Path $Target '.stage4-transaction.pending'
    foreach($file in @($path,$pending)) {
        if(Test-Path -LiteralPath $file) { Assert-Stage4JournalPath $file }
    }
    $bytes=[Text.Encoding]::UTF8.GetBytes(($Journal | ConvertTo-Json -Depth 8 -Compress))
    $stream=[IO.FileStream]::new($pending,[IO.FileMode]::Create,[IO.FileAccess]::Write,
        [IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) }
    finally { $stream.Dispose() }
    if(Test-Path -LiteralPath $path) { [IO.File]::Replace($pending,$path,$null) }
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
    $target=[IO.Path]::GetFullPath($TargetDirectory).TrimEnd('\')
    $temp=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
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
        if($journal.version -ne 1 -or $journal.target -cne $target -or
            $journal.tag -cnotmatch '^[a-f0-9]{32}$' -or
            $journal.phase -cnotin @('PREPARED','COMMITTED','ROLLED_BACK') -or
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
        if($journal.phase -ceq 'PREPARED') {
            if(-not (& $IsControlledServiceStopped)) { & $StopControlledService }
            if(-not (& $IsControlledServiceStopped)) {throw 'stage4_recovery_stop_unconfirmed'}
            & $RecoveryCheckpoint 'recovery-stopped'
            foreach($pin in $journal.files) {
                $name=[string]$pin.name;$live=Join-Path $target $name
                if($restore[$name] -cne $live) {
                    # Preserve the pinned backup throughout recovery, including
                    # recovery-process crashes. Copy to a new sibling then rename.
                    $copy=Join-Path $target ('.stage4-'+$journal.tag+'.recover.'+$name)
                    if(Test-Path -LiteralPath $copy) {Assert-Stage4JournalPath $copy}
                    Copy-Item -LiteralPath $restore[$name] -Destination $copy -Force
                    $flush=[IO.File]::Open($copy,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None)
                    try{$flush.Flush($true)}finally{$flush.Dispose()}
                    if((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash -ine $pin.oldHash -or
                        (Get-Acl -LiteralPath $copy).Sddl -cne $pin.sddl) {throw 'stage4_recovery_copy_not_pinned'}
                    if(Test-Path -LiteralPath $live) {Remove-Item -LiteralPath $live -Force}
                    & $RecoveryCheckpoint ('recovery-removed-'+$name)
                    Move-Item -LiteralPath $copy -Destination $live
                    & $RecoveryCheckpoint ('recovery-restored-'+$name)
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
        if(-not (& $IsControlledServiceRunning) -or -not (& $ValidateControlledRuntime)) {throw 'stage4_recovery_runtime_unhealthy'}
        if($journal.phase -cne 'COMMITTED') {$journal.phase='ROLLED_BACK';Write-Stage4TransactionJournal $target $journal}
        return [pscustomobject]@{kind='STAGE4_DURABLE_RECOVERY';phase=$journal.phase;isTemporaryFixture=$fixture;powerLossProven=$false}
    } finally { $lock.Dispose() }
}
