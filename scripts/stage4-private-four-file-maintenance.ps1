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
$checkRuntime = {
    # A local log line alone cannot attest which Agent process ran it.
    # Require a fresh LocalSystem process, stable PID and pinned on-disk Agent
    # hash in addition to the post-start heartbeat. This is still NOT an
    # independent server-side attestation of the installed build.
    Start-Sleep -Seconds 32
    if (-not (& $isRunning)) { return $false }
    if ($script:stage4ServiceStartUtc -eq [DateTime]::MinValue) { return $false }
    $service=Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'"
    if ($null -eq $service -or $service.ProcessId -le 0 -or
        $service.StartName -cne 'LocalSystem' -or $service.State -cne 'Running') { return $false }
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
    $heartbeatAfterStart=$false
    foreach($line in @(Get-Content -LiteralPath $log -Tail 2000)) {
        $pos=$line.IndexOf('agent_event ')
        if ($pos -lt 0) { continue }
        try {
            $payload=$line.Substring($pos+12) | ConvertFrom-Json
            if ($payload.event -cne 'heartbeat') { continue }
            $stamp=($line -split ' ')[0] -replace '([+-]\d{2})(\d{2})
$args=@{
    TargetDirectory=$installed
    CandidateDirectory=$CandidateDirectory
    OldHashes=$oldHashes
    NewHashes=$newHashes
    OldSddl=$oldSddl
    StopControlledService=$stop
    StartControlledService=$start
    IsControlledServiceRunning=$isRunning
    IsControlledServiceStopped=$isStopped
    ValidateControlledRuntime=$checkRuntime
    MaintenanceToken='STAGE4-PHYSICAL-MAINTENANCE-AUTHORIZED-BY-PREFLIGHT'
}
Invoke-Stage4FourFileTransactionCore @args | ConvertTo-Json -Depth 8
,'$1:$2'
            $parsed=[DateTimeOffset]::Parse($stamp,[Globalization.CultureInfo]::InvariantCulture)
            if ($parsed.UtcDateTime -ge $startedUtc -and
                $parsed.UtcDateTime -ge $script:stage4ServiceStartUtc) {
                $heartbeatAfterStart=$true
                break
            }
        } catch {}
    }
    if (-not $heartbeatAfterStart -or -not (& $isRunning)) { return $false }
    $serviceAfter=Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'"
    if ($null -eq $serviceAfter -or $serviceAfter.ProcessId -ne $service.ProcessId) { return $false }
    $hashAfter=(Get-FileHash -LiteralPath $expectedExe -Algorithm SHA256).Hash
    return (Test-Stage4NewProcessProof -ServiceStartUtc $script:stage4ServiceStartUtc `
        -ProcessCreationUtc $startedUtc -InitialProcessId $service.ProcessId `
        -FinalProcessId $serviceAfter.ProcessId -InitialFileHash $hash `
        -FinalFileHash $hashAfter -OldPinnedHash $oldHashes['gpubnb-agent.exe'] `
        -NewPinnedHash $newHashes['gpubnb-agent.exe'])
}
$args=@{
    TargetDirectory=$installed
    CandidateDirectory=$CandidateDirectory
    OldHashes=$oldHashes
    NewHashes=$newHashes
    OldSddl=$oldSddl
    StopControlledService=$stop
    StartControlledService=$start
    IsControlledServiceRunning=$isRunning
    IsControlledServiceStopped=$isStopped
    ValidateControlledRuntime=$checkRuntime
    MaintenanceToken='STAGE4-PHYSICAL-MAINTENANCE-AUTHORIZED-BY-PREFLIGHT'
}
Invoke-Stage4FourFileTransactionCore @args | ConvertTo-Json -Depth 8
