#Requires -Version 5.1
# PRIVATE PC1 Windows maintenance. Default preflight only.
# To mutate local files requires -Apply and explicit operator acknowledgement.
# Never writes credentials, quarantine, active bookings, database or Render.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$CandidateDirectory,
    [Parameter(Mandatory=$true)][string]$BackupDirectory,
    [Parameter(Mandatory=$true)][string]$ExpectedCandidateManifestSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedBackupManifestSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedCommit,
    [Parameter(Mandatory=$true)][string]$ExpectedPublisherSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedMachineId,
    [Parameter(Mandatory=$true)][string]$ExpectedGpuUuid,
    [string]$RenterAccount='gpubnb-renter-qual',
    [switch]$Apply,
    [switch]$OperatorPresentAndApproved
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
    throw 'stage4_maintenance_requires_windows_x64'
}
$principal=[Security.Principal.WindowsPrincipal]([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'stage4_maintenance_admin_required'
}
$installed='C:\Program Files\GPUbnb'
$source=Join-Path $PSScriptRoot 'stage4-private-four-file-transaction-core.ps1'
$sourceNode=Get-Item -LiteralPath $source -Force -ErrorAction Stop
if (($sourceNode.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'stage4_maintenance_core_symlink_forbidden'
}
. $source
$readinessArgs=@{
    CandidateDirectory=$CandidateDirectory
    BackupDirectory=$BackupDirectory
    ExpectedCandidateManifestSha256=$ExpectedCandidateManifestSha256
    ExpectedBackupManifestSha256=$ExpectedBackupManifestSha256
    ExpectedCommit=$ExpectedCommit
    ExpectedPublisherSha256=$ExpectedPublisherSha256
    ExpectedMachineId=$ExpectedMachineId
    ExpectedGpuUuid=$ExpectedGpuUuid
    RenterAccount=$RenterAccount
}
$readiness=(& (Join-Path $PSScriptRoot 'stage4-private-install-readiness.ps1') @readinessArgs | Out-String) | ConvertFrom-Json
[void](Assert-Stage4MaintenanceReadiness -Readiness $readiness)
$svc=Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'"
$exe=Join-Path $installed 'gpubnb-agent.exe'
$proc=if ($null -eq $svc) { $null } else {
    Get-CimInstance Win32_Process -Filter "ProcessId=$($svc.ProcessId)"
}
if ($null -eq $svc -or $null -eq $proc -or
    $svc.StartName -ne 'LocalSystem' -or $svc.State -ne 'Running' -or
    $proc.ExecutablePath -ine $exe -or $proc.SessionId -ne 0) {
    throw 'stage4_maintenance_exact_live_service_identity_failed'
}
$liveNative=@(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('gpubnb-windows-worker.exe','gpubnb-windows-stream.exe')
})
if ($liveNative.Count -ne 0) { throw 'stage4_maintenance_native_process_running' }

# The exact existing terminal claim is NOT modified. It must remain a fence
# until a later, signed server-authorized native cleanup diagnostic.
$configDir=Join-Path $env:ProgramData 'GPUbnb'
$claimPath=Join-Path $configDir 'gpu-resource-rental-v1.json'
$runtimePath=Join-Path $configDir 'gpu-resource-runtime-v1.json'
$claimFile=Get-Item -LiteralPath $claimPath -Force -ErrorAction Stop
$runtimeFile=Get-Item -LiteralPath $runtimePath -Force -ErrorAction Stop
if (($claimFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    ($runtimeFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'stage4_maintenance_authority_symlink_forbidden'
}
$claims=Get-Content -LiteralPath $claimPath -Raw | ConvertFrom-Json
$runtimes=Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
$claimEntries=@($claims.resources.PSObject.Properties)
$runtimeEntries=@($runtimes.resources.PSObject.Properties)
if ($claimEntries.Count -ne 1 -or $runtimeEntries.Count -ne 1) {
    throw 'stage4_maintenance_requires_exact_single_local_resource'
}
$claim=$claimEntries[0].Value
$runtime=$runtimeEntries[0].Value
$expectedSession='cmvvpd1s600aser1b06u33u86'
$expectedResource='e9ab8452-0349-4d3b-a209-868c633834a3'
if ($claimEntries[0].Name -cne $expectedResource -or
    $runtimeEntries[0].Name -cne $expectedResource -or
    $claim.session_id -cne $expectedSession -or
    $claim.hardware_uuid -ine $ExpectedGpuUuid -or
    $runtime.hardware_uuid -ine $ExpectedGpuUuid -or
    $claim.holder_id -cne ('rental:'+$expectedSession) -or
    $claim.state -cne 'RENTAL_ACTIVE' -or
    $runtime.state -cne 'STOPPED' -or
    $null -ne $runtime.pid -or $null -ne $runtime.command_id -or
    $null -ne $runtime.process_creation_token -or
    [string]$claim.fencing_token -cne [string]$claim.runtime_generation) {
    throw 'stage4_maintenance_local_claim_runtime_scope_changed'
}
try {
    $claimGeneration=[System.Numerics.BigInteger]::Parse([string]$claim.runtime_generation)
    $runtimeGeneration=[System.Numerics.BigInteger]::Parse([string]$runtime.runtime_generation)
} catch { throw 'stage4_maintenance_authority_generation_invalid' }
if ($claimGeneration -lt 1 -or $runtimeGeneration -lt $claimGeneration) {
    throw 'stage4_maintenance_authority_generation_regressed'
}

$names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe',
    'gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
$mp=Join-Path $CandidateDirectory 'stage4-private-qualification.manifest.json'
$bp=Join-Path $BackupDirectory 'backup.manifest.json'
if ((Get-FileHash -LiteralPath $mp -Algorithm SHA256).Hash -ine $ExpectedCandidateManifestSha256 -or
    (Get-FileHash -LiteralPath $bp -Algorithm SHA256).Hash -ine $ExpectedBackupManifestSha256) {
    throw 'stage4_maintenance_manifest_changed'
}
$candidate=Get-Content -LiteralPath $mp -Raw | ConvertFrom-Json
$backup=Get-Content -LiteralPath $bp -Raw | ConvertFrom-Json
$oldHashes=@{};$newHashes=@{};$oldSddl=@{}
foreach($name in $names) {
    $before=@($backup.files | Where-Object { $_.name -ceq $name })
    $after=@($candidate.files | Where-Object { $_.name -ceq $name })
    if ($before.Count -ne 1 -or $after.Count -ne 1) {
        throw 'stage4_maintenance_manifest_components_mismatch'
    }
    $oldHashes[$name]=$before[0].sha256
    $newHashes[$name]=$after[0].sha256
    $oldSddl[$name]=$before[0].sddl
}
if (-not $Apply) {
    [ordered]@{
        kind='STAGE4_PRIVATE_PHYSICAL_MAINTENANCE_PREFLIGHT'
        machineId=$ExpectedMachineId
        sourceCommit=$ExpectedCommit
        checksPassed=6
        exactlyOneTerminalClaimAndStoppedRuntime=$true
        serviceLocalSystemSessionZero=$true
        installedOriginalFilesMatchBackup=$true
        signedCandidatePinned=$true
        installationAuthorized=$false
        installationPerformed=$false
        rollbackServiceTested=$false
        quarantineModified=$false
        publicBookabilityEnabled=$false
    } | ConvertTo-Json -Depth 6
    return
}
if (-not $OperatorPresentAndApproved) {
    throw 'stage4_maintenance_explicit_operator_approval_required'
}
$oldBuildInfoRaw=@(& $exe 'build-info' 2>$null) -join "`n"
try { $oldBuildInfo=$oldBuildInfoRaw | ConvertFrom-Json } catch { throw 'stage4_maintenance_old_agent_build_info_invalid' }
$oldAgentCommit=[string]$oldBuildInfo.buildCommit
if ($oldAgentCommit -cnotmatch '^[0-9a-f]{40}$' -or
    [IO.Path]::GetFullPath([string]$oldBuildInfo.executable) -ine [IO.Path]::GetFullPath($exe) -or
    (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ine $oldHashes['gpubnb-agent.exe']) {
    throw 'stage4_maintenance_old_agent_identity_unpinned'
}
# Recheck exact original bytes and ACLs in the core immediately before staging,
# then STOP service before all four same-parent rename operations.
$script:stage4ServiceStartUtc=[DateTime]::MinValue
$stop = {
    $s=Get-Service -Name 'GPUbnbAgent' -ErrorAction Stop
    if ($s.Status -ne 'Stopped') {
        $s.Stop()
        $s.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(45))
    }
}
$start = {
    $s=Get-Service -Name 'GPUbnbAgent' -ErrorAction Stop
    if ($s.Status -ne 'Running') {
        $script:stage4CounterBeforeStart=& $readAgentCounter
        $script:stage4ServiceStartUtc=[DateTime]::UtcNow
        $s.Start()
        $s.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(45))
    }
}
$isRunning = {
    $s=Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'"
    if ($null -eq $s -or $s.State -ne 'Running' -or $s.StartName -ne 'LocalSystem' -or $s.ProcessId -le 0) { return $false }
    $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($s.ProcessId)"
    return ($null -ne $p -and $p.ExecutablePath -ieq 'C:\Program Files\GPUbnb\gpubnb-agent.exe' -and $p.SessionId -eq 0)
}
$isStopped = {
    return ((Get-Service -Name 'GPUbnbAgent').Status -eq 'Stopped')
}
$agentConfigPath=Join-Path (Join-Path $env:ProgramData 'GPUbnb') 'config.json'
$agentConfigItem=Get-Item -LiteralPath $agentConfigPath -Force -ErrorAction Stop
if (($agentConfigItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'stage4_maintenance_agent_config_symlink_forbidden'
}
$agentConfig=Get-Content -LiteralPath $agentConfigPath -Raw | ConvertFrom-Json
if ($agentConfig.machineId -cne $ExpectedMachineId) {
    throw 'stage4_maintenance_agent_machine_identity_mismatch'
}
$counterPath=Join-Path (Join-Path $env:ProgramData 'GPUbnb') 'counter'
$readAgentCounter = {
    $entry=Get-Item -LiteralPath $counterPath -Force -ErrorAction Stop
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $entry.PSIsContainer) {
        throw 'stage4_maintenance_counter_path_invalid'
    }
    $value=[long]0
    if (-not [long]::TryParse((Get-Content -LiteralPath $counterPath -Raw).Trim(),[ref]$value) -or $value -lt 0) {
        throw 'stage4_maintenance_counter_value_invalid'
    }
    return $value
}
$script:stage4CounterBeforeStart=$null
$checkRuntime = {
    # Require an accepted API heartbeat from this fresh service process. The
    # server response carries ok=true and a monotone counter saved by the Agent;
    # no arbitrary text-only log match can satisfy this gate.
    Start-Sleep -Seconds 32
    if (-not (& $isRunning)) { return $false }
    if ($script:stage4ServiceStartUtc -eq [DateTime]::MinValue) { return $false }
    $service=Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'"
    if ($null -eq $service -or $service.ProcessId -le 0 -or
        $service.StartName -cne 'LocalSystem' -or $service.State -cne 'Running') { return $false }
    $agentProcesses=@(Get-CimInstance Win32_Process -Filter "Name='gpubnb-agent.exe'")
    if ($agentProcesses.Count -ne 1 -or [int]$agentProcesses[0].ProcessId -ne [int]$service.ProcessId) { return $false }
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($service.ProcessId)"
    if ($null -eq $process -or $process.SessionId -ne 0 -or
        $process.ExecutablePath -ine 'C:\Program Files\GPUbnb\gpubnb-agent.exe' -or
        $null -eq $process.CreationDate) { return $false }
    try { $startedUtc=([DateTime]$process.CreationDate).ToUniversalTime() }
    catch { return $false }
    if ($startedUtc -lt $script:stage4ServiceStartUtc.AddSeconds(-5)) { return $false }
    $expectedExe='C:\Program Files\GPUbnb\gpubnb-agent.exe'
    $sig=Get-AuthenticodeSignature -LiteralPath $expectedExe
    if ($sig.Status -ne 'Valid') { return $false }
    $hash=(Get-FileHash -LiteralPath $expectedExe -Algorithm SHA256).Hash
    if ($hash -ine $newHashes['gpubnb-agent.exe'] -and
        $hash -ine $oldHashes['gpubnb-agent.exe']) { return $false }
    $log=Join-Path $env:ProgramData 'GPUbnb\agent.log'
    if (-not (Test-Path -LiteralPath $log -PathType Leaf)) { return $false }
    $startupProofAfterStart=$false
    $startupProofCommit=$null
    $heartbeatAfterStart=$false
    $pinnedLegacyHeartbeatAfterStart=$false
    $acceptedCounter=[long]0
    $readEventValue={param($event,[string]$name)$property=$event.PSObject.Properties[$name];if($null -eq $property){return $null};return $property.Value}
    foreach($line in @(Get-Content -LiteralPath $log -Tail 2000)) {
        $pos=$line.IndexOf('agent_event ')
        if ($pos -lt 0) { continue }
        try {
            $payload=$line.Substring($pos+12) | ConvertFrom-Json
            $stamp=($line -split ' ')[0] -replace '([+-]\d{2})(\d{2})$','$1:$2'
            $parsed=[DateTimeOffset]::Parse($stamp,[Globalization.CultureInfo]::InvariantCulture)
            if ($parsed.UtcDateTime -lt $startedUtc -or
                $parsed.UtcDateTime -lt $script:stage4ServiceStartUtc) { continue }
            if ($payload.event -ceq 'diagnostic_poll_loop_started') {
                $eventMachineId=& $readEventValue $payload 'machineId'
                $eventCommit=& $readEventValue $payload 'buildCommit'
                $eventProcessId=& $readEventValue $payload 'processId'
                $expectedProcessCommit=if($hash -ieq $oldHashes['gpubnb-agent.exe']){$oldAgentCommit}else{$ExpectedCommit}
                if ($eventMachineId -cne $ExpectedMachineId -or
                    $eventCommit -cne $expectedProcessCommit -or
                    ($null -ne $eventProcessId -and [int]$eventProcessId -ne [int]$service.ProcessId) -or
                    ($hash -ieq $newHashes['gpubnb-agent.exe'] -and [int]$eventProcessId -ne [int]$service.ProcessId)) { continue }
                $startupProofAfterStart=$true
                $startupProofCommit=[string]$eventCommit
                continue
            }
            if ($payload.event -ceq 'heartbeat') {
                $eventMachineId=& $readEventValue $payload 'machineId'
                $eventCommit=& $readEventValue $payload 'buildCommit'
                $eventProcessId=& $readEventValue $payload 'processId'
                $serverAccepted=& $readEventValue $payload 'serverAccepted'
                $eventCounter=& $readEventValue $payload 'counter'
                $heartbeatCounter=[long]0
                $enhancedProof=($eventMachineId -ceq $ExpectedMachineId -and
                    $eventCommit -cmatch '^[0-9a-f]{40}$' -and
                    $serverAccepted -is [bool] -and $serverAccepted -and
                    $payload.result.ok -is [bool] -and $payload.result.ok -and
                    [long]::TryParse([string]$eventCounter,[ref]$heartbeatCounter) -and
                    $heartbeatCounter -gt 0 -and
                    [int]$eventProcessId -eq [int]$service.ProcessId -and
                    [string]$eventCommit -ceq $startupProofCommit)
                if ($enhancedProof -and
                    $startupProofAfterStart -and
                    $eventCommit -ceq $startupProofCommit -and
                    $heartbeatCounter -gt $script:stage4CounterBeforeStart -and
                    (($hash -ieq $newHashes['gpubnb-agent.exe'] -and $eventCommit -ceq $ExpectedCommit) -or
                        ($hash -ieq $oldHashes['gpubnb-agent.exe'] -and $eventCommit -ceq $oldAgentCommit))) {
                    $acceptedCounter=$heartbeatCounter
                    $heartbeatAfterStart=$true
                    break
                }
                # The already installed rollback image predates explicit PID
                # heartbeat fields. Accept it only when its exact file hash and
                # build commit are pinned, its sole service process emitted a
                # fresh machine-bound startup event, and its successful server
                # response is followed by a monotone persisted counter advance.
                if ($hash -ieq $oldHashes['gpubnb-agent.exe'] -and
                    $startupProofAfterStart -and $eventCommit -ceq $oldAgentCommit -and
                    $payload.result.ok -is [bool] -and $payload.result.ok) {
                    $pinnedLegacyHeartbeatAfterStart=$true
                }
            }
        } catch {}
    }
    if (-not $startupProofAfterStart -or -not ($heartbeatAfterStart -or $pinnedLegacyHeartbeatAfterStart) -or -not (& $isRunning)) { return $false }
    if ($null -eq $script:stage4CounterBeforeStart) { return $false }
    try { $counterAfterStart=& $readAgentCounter } catch { return $false }
    if ($counterAfterStart -le $script:stage4CounterBeforeStart -or
        ($acceptedCounter -gt 0 -and $counterAfterStart -lt $acceptedCounter)) { return $false }
    if ($heartbeatAfterStart -and $acceptedCounter -le $script:stage4CounterBeforeStart) { return $false }
    $configAfter=Get-Content -LiteralPath $agentConfigPath -Raw | ConvertFrom-Json
    if ($configAfter.machineId -cne $ExpectedMachineId) { return $false }
    $serviceAfter=Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'"
    if ($null -eq $serviceAfter -or $serviceAfter.ProcessId -ne $service.ProcessId) { return $false }
    $hashAfter=(Get-FileHash -LiteralPath $expectedExe -Algorithm SHA256).Hash
    return (Test-Stage4NewProcessProof -ServiceStartUtc $script:stage4ServiceStartUtc -ProcessCreationUtc $startedUtc -InitialProcessId $service.ProcessId -FinalProcessId $serviceAfter.ProcessId -InitialFileHash $hash -FinalFileHash $hashAfter -OldPinnedHash $oldHashes['gpubnb-agent.exe'] -NewPinnedHash $newHashes['gpubnb-agent.exe'])
}
$args=@{
    TargetDirectory=$installed
    CandidateDirectory=$CandidateDirectory
    OldHashes=$oldHashes
    NewHashes=$newHashes
    OldSddl=$oldSddl
    OldAgentCommit=$oldAgentCommit
    NewAgentCommit=$ExpectedCommit
    StopControlledService=$stop
    StartControlledService=$start
    IsControlledServiceRunning=$isRunning
    IsControlledServiceStopped=$isStopped
    ValidateControlledRuntime=$checkRuntime
    MaintenanceToken='STAGE4-PHYSICAL-MAINTENANCE-AUTHORIZED-BY-PREFLIGHT'
}
Invoke-Stage4FourFileTransactionCore @args | ConvertTo-Json -Depth 8
