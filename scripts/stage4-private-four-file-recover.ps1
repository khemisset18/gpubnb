#Requires -Version 5.1
# Independent, explicit entry point for recovery after the maintenance process exits.
# Default mode is read-only. This script is never invoked by the service or CI on PC1.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ExpectedMachineId,
    [switch]$Recover,
    [switch]$OperatorPresentAndApproved
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
    throw 'stage4_recovery_requires_windows_x64'
}
$principal=[Security.Principal.WindowsPrincipal]([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'stage4_recovery_admin_required'
}
if ($ExpectedMachineId -cnotmatch '^[a-zA-Z0-9_-]{8,128}$') {
    throw 'stage4_recovery_machine_id_invalid'
}
$target='C:\Program Files\GPUbnb'
$source=Join-Path $PSScriptRoot 'stage4-private-transaction-journal.ps1'
. $source
Assert-Stage4JournalPath $target
$journalPath=Join-Path $target '.stage4-transaction.json'
Assert-Stage4JournalPath $journalPath
$journal=Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
if ($journal.version -ne 2 -or $journal.target -cne $target -or
    $journal.tag -cnotmatch '^[a-f0-9]{32}$' -or
    $journal.oldAgentCommit -cnotmatch '^[0-9a-f]{40}$' -or
    $journal.newAgentCommit -cnotmatch '^[0-9a-f]{40}$' -or
    $journal.phase -cnotin @('PREPARED','REPLACING','VALIDATING','RESTORING','COMMITTED','ROLLED_BACK') -or
    @($journal.files).Count -ne 4) {
    throw 'stage4_recovery_journal_invalid'
}
$agentPin=@($journal.files | Where-Object { $_.name -ceq 'gpubnb-agent.exe' })
if ($agentPin.Count -ne 1 -or
    $agentPin[0].oldHash -cnotmatch '^[0-9A-Fa-f]{64}$' -or
    $agentPin[0].newHash -cnotmatch '^[0-9A-Fa-f]{64}$') {
    throw 'stage4_recovery_agent_pin_invalid'
}
$configPath=Join-Path $env:ProgramData 'GPUbnb\config.json'
Assert-Stage4JournalPath $configPath
$config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($config.machineId -cne $ExpectedMachineId) {
    throw 'stage4_recovery_machine_identity_mismatch'
}
$counterPath=Join-Path $env:ProgramData 'GPUbnb\counter'
Assert-Stage4JournalPath $counterPath
$readCounter={
    $entry=Get-Item -LiteralPath $counterPath -Force -ErrorAction Stop
    if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'stage4_recovery_counter_path_invalid'
    }
    $value=[long]0
    if (-not [long]::TryParse((Get-Content -LiteralPath $counterPath -Raw).Trim(),[ref]$value) -or $value -lt 0) {
        throw 'stage4_recovery_counter_invalid'
    }
    return $value
}
$service=Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'"
if ($null -eq $service -or $service.StartName -cne 'LocalSystem' -or
    $service.PathName -notlike '"C:\Program Files\GPUbnb\gpubnb-agent.exe"*') {
    throw 'stage4_recovery_service_identity_invalid'
}
$initialCounter=& $readCounter
if (-not $Recover) {
    [ordered]@{
        kind='STAGE4_PRIVATE_RECOVERY_PREFLIGHT_READONLY'
        phase=$journal.phase
        machineId=$ExpectedMachineId
        fourFileJournalPresent=$true
        counter=$initialCounter
        recoveryPerformed=$false
        installAuthorized=$false
    } | ConvertTo-Json -Depth 5
    return
}
if (-not $OperatorPresentAndApproved) {
    throw 'stage4_recovery_explicit_operator_approval_required'
}
$liveNative=@(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('gpubnb-windows-worker.exe','gpubnb-windows-stream.exe')
})
if ($liveNative.Count -ne 0) { throw 'stage4_recovery_native_process_still_running' }
$script:stage4RecoveryCounterBeforeStart=$initialCounter
$script:stage4RecoveryStartUtc=[DateTime]::UtcNow
$stop={
    $s=Get-Service -Name 'GPUbnbAgent' -ErrorAction Stop
    if ($s.Status -ne 'Stopped') {
        $s.Stop();$s.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(45))
    }
}
$start={
    $s=Get-Service -Name 'GPUbnbAgent' -ErrorAction Stop
    if ($s.Status -ne 'Running') {
        $script:stage4RecoveryStartUtc=[DateTime]::UtcNow
        $s.Start();$s.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(45))
    }
}
$isRunning={
    $s=Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'"
    if ($null -eq $s -or $s.State -ne 'Running' -or $s.StartName -cne 'LocalSystem' -or $s.ProcessId -le 0) { return $false }
    $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($s.ProcessId)"
    return ($null -ne $p -and $p.ExecutablePath -ieq 'C:\Program Files\GPUbnb\gpubnb-agent.exe' -and $p.SessionId -eq 0)
}
$isStopped={ return ((Get-Service -Name 'GPUbnbAgent').Status -eq 'Stopped') }
$validate={
    Start-Sleep -Seconds 32
    if (-not (& $isRunning)) { return $false }
    $s=Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'"
    $agents=@(Get-CimInstance Win32_Process -Filter "Name='gpubnb-agent.exe'")
    if ($agents.Count -ne 1 -or [int]$agents[0].ProcessId -ne [int]$s.ProcessId) { return $false }
    $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($s.ProcessId)"
    if ($null -eq $p -or $null -eq $p.CreationDate -or $p.SessionId -ne 0) { return $false }
    try { $created=([DateTime]$p.CreationDate).ToUniversalTime() } catch { return $false }
    $exe='C:\Program Files\GPUbnb\gpubnb-agent.exe'
    $hash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
    if ($hash -ine $agentPin[0].oldHash -and $hash -ine $agentPin[0].newHash) { return $false }
    $expectedBuildCommit=if($hash -ieq $agentPin[0].oldHash){[string]$journal.oldAgentCommit}else{[string]$journal.newAgentCommit}
    if ((Get-AuthenticodeSignature -LiteralPath $exe).Status -ne 'Valid') { return $false }
    $log=Join-Path $env:ProgramData 'GPUbnb\agent.log'
    if (-not (Test-Path -LiteralPath $log -PathType Leaf)) { return $false }
    Assert-Stage4JournalPath $log
    $startupCommit=$null;$heartbeatAccepted=$false;$legacyHeartbeatAccepted=$false;$acceptedCounter=[long]0
    $readEventValue={param($event,[string]$name)$property=$event.PSObject.Properties[$name];if($null -eq $property){return $null};return $property.Value}
    foreach($line in @(Get-Content -LiteralPath $log -Tail 2000)) {
        $pos=$line.IndexOf('agent_event ')
        if ($pos -lt 0) { continue }
        try {
            $event=$line.Substring($pos+12) | ConvertFrom-Json
            $stamp=($line -split ' ')[0] -replace '([+-]\d{2})(\d{2})$','$1:$2'
            $eventUtc=([DateTimeOffset]::Parse($stamp,[Globalization.CultureInfo]::InvariantCulture)).UtcDateTime
            if ($eventUtc -lt $created) { continue }
            if ($event.event -ceq 'diagnostic_poll_loop_started' -and
                $event.machineId -ceq $ExpectedMachineId -and
                $event.buildCommit -ceq $expectedBuildCommit -and
                (($null -eq (& $readEventValue $event 'processId') -and $hash -ieq $agentPin[0].oldHash) -or
                    [int](& $readEventValue $event 'processId') -eq [int]$s.ProcessId)) {
                $startupCommit=[string]$event.buildCommit
                continue
            }
            if ($event.event -ceq 'heartbeat' -and $null -ne $startupCommit -and
                $event.result.ok -is [bool] -and $event.result.ok) {
                $eventProcessId=& $readEventValue $event 'processId'
                if ($event.machineId -cne $ExpectedMachineId -or
                    [int]$eventProcessId -ne [int]$s.ProcessId -or
                    $event.buildCommit -cne $startupCommit -or
                    $event.serverAccepted -isnot [bool] -or -not $event.serverAccepted -or
                    -not [long]::TryParse([string]$event.counter,[ref]$acceptedCounter) -or
                    $acceptedCounter -le $script:stage4RecoveryCounterBeforeStart) { continue }
                $heartbeatAccepted=$true
                break
            }
            if ($event.event -ceq 'heartbeat' -and $null -ne $startupCommit -and
                $hash -ieq $agentPin[0].oldHash -and
                $event.result.ok -is [bool] -and $event.result.ok) {
                # Older pinned Agent builds logged the accepted API response but
                # did not include PID/counter fields. The outer validation has
                # already required a sole fresh service process, exact old file
                # hash, matching build commit and machine-bound startup event;
                # the persisted anti-replay counter is checked after this loop.
                $legacyHeartbeatAccepted=$true
            }
        } catch {}
    }
    if (-not ($heartbeatAccepted -or $legacyHeartbeatAccepted)) { return $false }
    try { $counterAfter=& $readCounter } catch { return $false }
    if ($counterAfter -le $script:stage4RecoveryCounterBeforeStart -or
        ($heartbeatAccepted -and $counterAfter -lt $acceptedCounter)) { return $false }
    $configAfter=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($configAfter.machineId -cne $ExpectedMachineId) { return $false }
    $sAfter=Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'"
    return ($null -ne $sAfter -and $sAfter.ProcessId -eq $s.ProcessId -and (& $isRunning))
}
$result=Invoke-Stage4FourFileRecovery @{
    TargetDirectory=$target
    StopControlledService=$stop
    StartControlledService=$start
    IsControlledServiceRunning=$isRunning
    IsControlledServiceStopped=$isStopped
    ValidateControlledRuntime=$validate
    MaintenanceToken='STAGE4-PHYSICAL-MAINTENANCE-AUTHORIZED-BY-PREFLIGHT'
}
$result | ConvertTo-Json -Depth 8
