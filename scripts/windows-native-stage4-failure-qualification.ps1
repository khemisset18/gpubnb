#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Preflight', 'HelperCrash', 'AgentRestart', 'NetworkInterruption', 'RebootPrepare', 'RebootVerify')]
    [string]$Scenario,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9_-]{1,200}$')]
    [string]$SessionId,

    [string]$HelperPath = "$env:ProgramFiles\GPUbnb\gpubnb-windows-stream.exe",
    [string]$ServiceName = 'GPUbnbAgent',

    [ValidateRange(15, 300)]
    [int]$RecoveryTimeoutSeconds = 90,

    [ValidateRange(60, 120)]
    [int]$NetworkBlockSeconds = 75,

    [switch]$ArmFaults,

    # Internal marker used only by the temporary Task Scheduler relay.
    [switch]$SystemRelay,

    [string]$EvidencePath,

    [string]$RebootMarkerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'stage4_administrator_required'
    }
}

function Resolve-CanonicalFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "stage4_file_missing:$Path"
    }
    return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)
}

function Get-CertificateSha256 {
    param([Parameter(Mandatory = $true)]$Certificate)
    return $Certificate.GetCertHashString(
        [Security.Cryptography.HashAlgorithmName]::SHA256
    ).ToLowerInvariant()
}

function Get-SignedFileProof {
    param([Parameter(Mandatory = $true)][string]$Path)
    $canonical = Resolve-CanonicalFile -Path $Path
    $signature = Get-AuthenticodeSignature -LiteralPath $canonical
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
        throw "stage4_signature_invalid:$canonical"
    }
    if ($null -eq $signature.SignerCertificate) {
        throw "stage4_signer_missing:$canonical"
    }
    return [ordered]@{
        path = $canonical
        sha256 = (Get-FileHash -LiteralPath $canonical -Algorithm SHA256).Hash.ToLowerInvariant()
        signerCertificateSha256 = Get-CertificateSha256 -Certificate $signature.SignerCertificate
        signerSubject = [string]$signature.SignerCertificate.Subject
    }
}

function Invoke-HelperStatus {
    $raw = & $script:HelperCanonical '--status' '--json' '--session-id' $SessionId 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    try {
        $value = ($raw | Out-String).Trim() | ConvertFrom-Json
    }
    catch {
        throw 'stage4_helper_status_invalid_json'
    }
    if ([string]$value.sessionId -cne $SessionId -or $value.running -ne $true) {
        throw 'stage4_helper_status_identity_mismatch'
    }
    return $value
}

function Test-HelperReady {
    param($Status)
    if ($null -eq $Status) { return $false }
    foreach ($field in @(
        'running',
        'isolatedSession',
        'renterSessionActive',
        'providerSessionInactive',
        'virtualDisplay',
        'providerDesktopExcluded',
        'exactGpuBound',
        'captureReady',
        'nvencReady',
        'mediaReady',
        'inputIsolation',
        'inputReady'
    )) {
        if ($Status.$field -ne $true) { return $false }
    }
    if ($Status.suspended -eq $true) { return $false }
    return ([string]$Status.hardwareEncoder).ToLowerInvariant() -eq 'nvenc'
}

function Get-AuthorityProcesses {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='gpubnb-windows-stream.exe'")
    $result = @()
    foreach ($process in $all) {
        $actual = [string]$process.ExecutablePath
        $command = [string]$process.CommandLine
        if ([string]::IsNullOrWhiteSpace($actual) -or [string]::IsNullOrWhiteSpace($command)) {
            continue
        }
        try {
            $actualFull = [IO.Path]::GetFullPath($actual)
        }
        catch {
            continue
        }
        if (-not [string]::Equals(
            $actualFull,
            $script:HelperCanonical,
            [StringComparison]::OrdinalIgnoreCase
        )) {
            continue
        }
        if ($command -notmatch '(?i)(^|\s)--authority-child(\s|$)') {
            continue
        }
        $escapedSession = [regex]::Escape($SessionId)
        $sessionPattern = '(?i)(^|\s)--session-id\s+"?' + $escapedSession + '"?(\s|$)'
        if ($command -notmatch $sessionPattern) {
            continue
        }
        $result += $process
    }
    return @($result)
}

function Get-SingleAuthorityProcess {
    $matches = @(Get-AuthorityProcesses)
    if ($matches.Count -ne 1) {
        throw "stage4_authority_process_count:$($matches.Count)"
    }
    return $matches[0]
}

function Wait-For {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Probe,
        [Parameter(Mandatory = $true)][string]$FailureCode
    )
    $deadline = (Get-Date).AddSeconds($RecoveryTimeoutSeconds)
    do {
        $value = & $Probe
        if ($null -ne $value -and $value -ne $false) {
            return $value
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw $FailureCode
}

function Observe-NativePostFaultOutcome {
    param(
        [Parameter(Mandatory = $true)][uint32]$OldAuthorityPid,
        [switch]$AllowSameAuthority
    )
    $deadline = (Get-Date).AddSeconds($RecoveryTimeoutSeconds)
    $noAuthoritySince = $null

    do {
        $matches = @(Get-AuthorityProcesses)
        $status = $null
        try {
            $status = Invoke-HelperStatus
        }
        catch {
            $status = $null
        }

        if ($matches.Count -eq 1 -and (Test-HelperReady -Status $status)) {
            $pid = [uint32]$matches[0].ProcessId
            if ($AllowSameAuthority -or $pid -ne $OldAuthorityPid) {
                return [ordered]@{
                    outcome = 'recovered'
                    authorityPid = $pid
                    helperStatus = $status
                }
            }
        }

        if ($matches.Count -eq 0 -and $null -eq $status) {
            if ($null -eq $noAuthoritySince) {
                $noAuthoritySince = Get-Date
            }
            elseif (((Get-Date) - $noAuthoritySince).TotalSeconds -ge 5) {
                return [ordered]@{
                    outcome = 'fail_closed'
                    authorityPid = $null
                    helperStatus = $null
                }
            }
        }
        else {
            $noAuthoritySince = $null
        }

        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    throw 'stage4_native_post_fault_outcome_timeout'
}

function Get-ServiceProof {
    $safeName = $ServiceName.Replace("'", "''")
    $service = Get-CimInstance Win32_Service -Filter "Name='$safeName'"
    if ($null -eq $service) {
        throw 'stage4_agent_service_missing'
    }
    $pathName = ([string]$service.PathName).Trim()
    if ([string]::IsNullOrWhiteSpace($pathName)) {
        throw 'stage4_agent_service_path_missing'
    }
    if ($pathName.StartsWith([string][char]34)) {
        $endQuote = $pathName.IndexOf([char]34, 1)
        if ($endQuote -lt 2) {
            throw 'stage4_agent_service_path_invalid'
        }
        $exe = $pathName.Substring(1, $endQuote - 1)
    }
    else {
        $exeEnd = $pathName.IndexOf('.exe', [StringComparison]::OrdinalIgnoreCase)
        if ($exeEnd -lt 0) {
            throw 'stage4_agent_service_path_invalid'
        }
        $exe = $pathName.Substring(0, $exeEnd + 4).Trim()
    }
    $canonical = Resolve-CanonicalFile -Path $exe
    if ([IO.Path]::GetFileName($canonical) -ine 'gpubnb-agent.exe') {
        throw 'stage4_agent_service_executable_mismatch'
    }
    return [ordered]@{
        name = [string]$service.Name
        state = [string]$service.State
        processId = [uint32]$service.ProcessId
        executable = Get-SignedFileProof -Path $canonical
    }
}

function Assert-FaultsArmed {
    if (-not $ArmFaults) {
        throw 'stage4_faults_not_armed'
    }
}

function Get-Stage4Root {
    $root = Join-Path $env:ProgramData 'GPUbnb\qualification\stage4'
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    return $root
}

function Get-RebootMarkerPath {
    if (-not [string]::IsNullOrWhiteSpace($RebootMarkerPath)) {
        return [IO.Path]::GetFullPath($RebootMarkerPath)
    }
    return Join-Path (Get-Stage4Root) ("reboot-$SessionId.json")
}

function Remove-Stage4FirewallRules {
    param([string[]]$Names)
    foreach ($name in $Names) {
        Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue
    }
}

function Start-FirewallRollbackWatchdog {
    param(
        [Parameter(Mandatory = $true)][string[]]$RuleNames,
        [Parameter(Mandatory = $true)][int]$DelaySeconds
    )
    $root = Get-Stage4Root
    $watchdogPath = Join-Path $root ("network-watchdog-$SessionId-$([Guid]::NewGuid().ToString('N')).ps1")
    $quotedRules = ($RuleNames | ForEach-Object { "'$($_.Replace("'", "''"))'" }) -join ','
    $watchdog = @'
Start-Sleep -Seconds __DELAY__
foreach ($name in @(__RULES__)) {
    Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
'@
    $watchdog = $watchdog.Replace('__DELAY__', [string]$DelaySeconds)
    $watchdog = $watchdog.Replace('__RULES__', $quotedRules)
    [IO.File]::WriteAllText($watchdogPath, $watchdog, [Text.UTF8Encoding]::new($false))
    $powershell = Join-Path $PSHOME 'powershell.exe'
    Start-Process -FilePath $powershell -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $watchdogPath
    ) -WindowStyle Hidden | Out-Null
    return $watchdogPath
}

function Test-LocalSystem {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (
        $null -ne $identity.User -and
        [string]$identity.User.Value -eq 'S-1-5-18'
    )
}

function Assert-LocalSystem {
    if (-not (Test-LocalSystem)) {
        throw 'stage4_localsystem_required'
    }
}

function Invoke-LocalSystemRelay {
    if ($SystemRelay) {
        throw 'stage4_system_relay_identity_invalid'
    }
    if ([string]::IsNullOrWhiteSpace($PSCommandPath) -or
        -not (Test-Path -LiteralPath $PSCommandPath -PathType Leaf)) {
        throw 'stage4_system_relay_source_missing'
    }

    $root = Get-Stage4Root
    $nonce = [Guid]::NewGuid().ToString('N')
    $taskName = "GPUbnb-Stage4-$nonce"
    $runnerPath = Join-Path $root ("relay-runner-$nonce.ps1")
    $wrapperPath = Join-Path $root ("relay-wrapper-$nonce.ps1")
    $inputPath = Join-Path $root ("relay-input-$nonce.json")
    $resultPath = Join-Path $root ("relay-result-$nonce.json")
    $childEvidencePath = if ([string]::IsNullOrWhiteSpace($EvidencePath)) {
        Join-Path $root ("windows-native-$($Scenario.ToLowerInvariant())-$SessionId.json")
    }
    else {
        [IO.Path]::GetFullPath($EvidencePath)
    }

    Copy-Item -LiteralPath $PSCommandPath -Destination $runnerPath -Force

    $relayInput = [ordered]@{
        scenario = $Scenario
        sessionId = $SessionId
        helperPath = $HelperPath
        serviceName = $ServiceName
        recoveryTimeoutSeconds = $RecoveryTimeoutSeconds
        networkBlockSeconds = $NetworkBlockSeconds
        armFaults = [bool]$ArmFaults
        evidencePath = $childEvidencePath
        rebootMarkerPath = $RebootMarkerPath
    }
    [IO.File]::WriteAllText(
        $inputPath,
        ($relayInput | ConvertTo-Json -Depth 6) + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )

    $wrapper = @'
$ErrorActionPreference = 'Stop'
$inputPath = '__INPUT__'
$runnerPath = '__RUNNER__'
$resultPath = '__RESULT__'
$exitCode = 1
$output = ''
try {
    $p = Get-Content -LiteralPath $inputPath -Raw | ConvertFrom-Json
    $invoke = @{
        Scenario = [string]$p.scenario
        SessionId = [string]$p.sessionId
        HelperPath = [string]$p.helperPath
        ServiceName = [string]$p.serviceName
        RecoveryTimeoutSeconds = [int]$p.recoveryTimeoutSeconds
        NetworkBlockSeconds = [int]$p.networkBlockSeconds
        EvidencePath = [string]$p.evidencePath
        SystemRelay = $true
    }
    if ([bool]$p.armFaults) { $invoke.ArmFaults = $true }
    if (-not [string]::IsNullOrWhiteSpace([string]$p.rebootMarkerPath)) {
        $invoke.RebootMarkerPath = [string]$p.rebootMarkerPath
    }
    $output = (& $runnerPath @invoke 2>&1 | Out-String)
    $exitCode = 0
}
catch {
    $output = ($_ | Out-String)
    $exitCode = 1
}
$result = [ordered]@{ exitCode = $exitCode; output = $output }
[IO.File]::WriteAllText(
    $resultPath,
    ($result | ConvertTo-Json -Depth 4) + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false)
)
exit $exitCode
'@
    $wrapper = $wrapper.Replace('__INPUT__', $inputPath.Replace("'", "''"))
    $wrapper = $wrapper.Replace('__RUNNER__', $runnerPath.Replace("'", "''"))
    $wrapper = $wrapper.Replace('__RESULT__', $resultPath.Replace("'", "''"))
    [IO.File]::WriteAllText($wrapperPath, $wrapper, [Text.UTF8Encoding]::new($false))

    $registered = $false
    try {
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $action = New-ScheduledTaskAction -Execute $powershell -Argument (
            '-NoProfile -ExecutionPolicy Bypass -File "' + $wrapperPath + '"'
        )
        $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
        $registered = $true
        Start-ScheduledTask -TaskName $taskName

        $relayTimeoutSeconds = [Math]::Max(
            300,
            $RecoveryTimeoutSeconds + $NetworkBlockSeconds + 120
        )
        $deadline = (Get-Date).AddSeconds($relayTimeoutSeconds)
        while (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
            if ((Get-Date) -ge $deadline) { throw 'stage4_system_relay_timeout' }
            Start-Sleep -Milliseconds 250
        }

        try {
            $relayResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        }
        catch {
            throw 'stage4_system_relay_result_invalid'
        }
        if ($null -eq $relayResult.exitCode) {
            throw 'stage4_system_relay_result_invalid'
        }

        $relayOutput = [string]$relayResult.output
        if (-not [string]::IsNullOrWhiteSpace($relayOutput)) {
            Write-Output $relayOutput.TrimEnd()
        }
        if ([int]$relayResult.exitCode -ne 0) {
            throw 'stage4_system_relay_failed'
        }
    }
    finally {
        if ($registered) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $runnerPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $wrapperPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $inputPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
    }
}

Assert-Administrator
if (-not (Test-LocalSystem)) {
    Invoke-LocalSystemRelay
    return
}
Assert-LocalSystem
$script:HelperCanonical = Resolve-CanonicalFile -Path $HelperPath
$helperProof = Get-SignedFileProof -Path $script:HelperCanonical
$initialService = Get-ServiceProof
$initialStatus = $null
$initialAuthority = $null

if ($Scenario -ne 'RebootVerify') {
    $initialStatus = Invoke-HelperStatus
    if (-not (Test-HelperReady -Status $initialStatus)) {
        throw 'stage4_helper_not_ready_before_fault'
    }
    $initialAuthority = Get-SingleAuthorityProcess
}

$startedAt = (Get-Date).ToUniversalTime()
$evidence = [ordered]@{
    schemaVersion = 2
    scenario = $Scenario
    sessionId = $SessionId
    startedAt = $startedAt.ToString('o')
    helper = $helperProof
    initial = [ordered]@{
        authorityPid = if ($null -ne $initialAuthority) { [uint32]$initialAuthority.ProcessId } else { $null }
        helperStatus = $initialStatus
        agentService = $initialService
    }
    result = $null
}

switch ($Scenario) {
    'Preflight' {
        $evidence.result = [ordered]@{
            localSafetyPass = $true
            faultInjected = $false
            authorityPid = [uint32]$initialAuthority.ProcessId
            helperReady = $true
            agentRunning = ($initialService.state -eq 'Running')
        }
    }

    'HelperCrash' {
        Assert-FaultsArmed
        $oldPid = [uint32]$initialAuthority.ProcessId

        # Never kill by image name. The PID was selected only after exact installed
        # path + authority-child + exact session-id proof above.
        Stop-Process -Id $oldPid -Force -ErrorAction Stop

        Wait-For -FailureCode 'stage4_old_authority_did_not_exit' -Probe {
            if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { return $false }
            return $true
        } | Out-Null

        $postFault = Observe-NativePostFaultOutcome -OldAuthorityPid $oldPid
        $evidence.result = [ordered]@{
            localSafetyPass = $true
            overallAcceptancePendingServerEvidence = $true
            faultInjected = $true
            oldAuthorityPid = $oldPid
            outcome = $postFault.outcome
            authorityPidAfterFault = $postFault.authorityPid
            helperStatusAfterFault = $postFault.helperStatus
            staleReadyRejected = $true
        }
    }

    'AgentRestart' {
        Assert-FaultsArmed
        $service = Get-Service -Name $ServiceName -ErrorAction Stop
        if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Running) {
            throw 'stage4_agent_not_running_before_restart'
        }

        $beforePid = [uint32](Get-ServiceProof).processId
        $oldAuthorityPid = [uint32]$initialAuthority.ProcessId

        Stop-Service -Name $ServiceName -ErrorAction Stop
        $service = Get-Service -Name $ServiceName -ErrorAction Stop
        $service.WaitForStatus(
            [ServiceProcess.ServiceControllerStatus]::Stopped,
            [TimeSpan]::FromSeconds(30)
        )

        Start-Service -Name $ServiceName -ErrorAction Stop
        $service = Get-Service -Name $ServiceName -ErrorAction Stop
        $service.WaitForStatus(
            [ServiceProcess.ServiceControllerStatus]::Running,
            [TimeSpan]::FromSeconds(30)
        )

        $afterService = Wait-For -FailureCode 'stage4_agent_restart_timeout' -Probe {
            try {
                $proof = Get-ServiceProof
                if ($proof.state -ne 'Running' -or [uint32]$proof.processId -eq 0) {
                    return $null
                }
                return $proof
            }
            catch {
                return $null
            }
        }

        $postFault = Observe-NativePostFaultOutcome -OldAuthorityPid $oldAuthorityPid -AllowSameAuthority
        $evidence.result = [ordered]@{
            localSafetyPass = $true
            overallAcceptancePendingServerEvidence = $true
            faultInjected = $true
            oldAgentPid = $beforePid
            newAgentPid = [uint32]$afterService.processId
            outcome = $postFault.outcome
            authorityPidAfterFault = $postFault.authorityPid
            helperStatusAfterFault = $postFault.helperStatus
        }
    }

    'NetworkInterruption' {
        Assert-FaultsArmed

        if ($initialService.state -ne 'Running' -or [uint32]$initialService.processId -eq 0) {
            throw 'stage4_agent_not_running_before_network_fault'
        }

        $agentPath = [string]$initialService.executable.path
        $installDirectory = Split-Path -Parent $agentPath
        $tunnelPath = Join-Path $installDirectory 'gpubnb-host-tunnel.exe'
        $tunnelProof = Get-SignedFileProof -Path $tunnelPath

        $agentRule = "GPUbnbStage4-$SessionId-Agent443"
        $tunnelRule = "GPUbnbStage4-$SessionId-Tunnel443"
        $ruleNames = @($agentRule, $tunnelRule)

        foreach ($name in $ruleNames) {
            if (Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue) {
                throw "stage4_firewall_rule_already_exists:$name"
            }
        }

        $watchdogSeconds = $NetworkBlockSeconds + 15
        $watchdogPath = Start-FirewallRollbackWatchdog -RuleNames $ruleNames -DelaySeconds $watchdogSeconds
        $blockStartedAt = (Get-Date).ToUniversalTime()

        try {
            New-NetFirewallRule -Name $agentRule -DisplayName $agentRule -Direction Outbound -Action Block -Program $agentPath -Protocol TCP -RemotePort 443 -Profile Any | Out-Null
            New-NetFirewallRule -Name $tunnelRule -DisplayName $tunnelRule -Direction Outbound -Action Block -Program ([string]$tunnelProof.path) -Protocol TCP -RemotePort 443 -Profile Any | Out-Null

            foreach ($name in $ruleNames) {
                $rule = Get-NetFirewallRule -Name $name -ErrorAction Stop
                if ($rule.Enabled -ne 'True' -or $rule.Action -ne 'Block' -or $rule.Direction -ne 'Outbound') {
                    throw "stage4_firewall_rule_invalid:$name"
                }
            }

            Start-Sleep -Seconds $NetworkBlockSeconds
        }
        finally {
            Remove-Stage4FirewallRules -Names $ruleNames
        }

        foreach ($name in $ruleNames) {
            if (Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue) {
                throw "stage4_firewall_rule_cleanup_failed:$name"
            }
        }

        $serviceAfter = Wait-For -FailureCode 'stage4_agent_service_not_running_after_network_fault' -Probe {
            try {
                $proof = Get-ServiceProof
                if ($proof.state -eq 'Running' -and [uint32]$proof.processId -ne 0) {
                    return $proof
                }
            }
            catch {}
            return $null
        }

        $postFault = Observe-NativePostFaultOutcome -OldAuthorityPid ([uint32]$initialAuthority.ProcessId) -AllowSameAuthority

        $evidence.result = [ordered]@{
            localSafetyPass = $true
            overallAcceptancePendingServerEvidence = $true
            faultInjected = $true
            networkScope = 'GPUbnb executables outbound TCP/443 only'
            blockedSeconds = $NetworkBlockSeconds
            blockStartedAt = $blockStartedAt.ToString('o')
            blockEndedAt = (Get-Date).ToUniversalTime().ToString('o')
            watchdogPath = $watchdogPath
            tunnel = $tunnelProof
            agentServiceAfterFault = $serviceAfter
            outcome = $postFault.outcome
            authorityPidAfterFault = $postFault.authorityPid
            helperStatusAfterFault = $postFault.helperStatus
            firewallRulesRemoved = $true
        }
    }

    'RebootPrepare' {
        Assert-FaultsArmed
        $markerPath = Get-RebootMarkerPath
        $markerParent = Split-Path -Parent $markerPath
        New-Item -ItemType Directory -Path $markerParent -Force | Out-Null

        $marker = [ordered]@{
            schemaVersion = 1
            sessionId = $SessionId
            preparedAt = (Get-Date).ToUniversalTime().ToString('o')
            helperSha256 = [string]$helperProof.sha256
            agentSha256 = [string]$initialService.executable.sha256
            authorityPid = [uint32]$initialAuthority.ProcessId
            agentPid = [uint32]$initialService.processId
        }
        [IO.File]::WriteAllText(
            $markerPath,
            ($marker | ConvertTo-Json -Depth 8) + [Environment]::NewLine,
            [Text.UTF8Encoding]::new($false)
        )

        $evidence.result = [ordered]@{
            localSafetyPass = $true
            faultInjected = $false
            manualRebootRequired = $true
            markerPath = $markerPath
            automatedRebootCommandIssued = $false
        }
    }

    'RebootVerify' {
        $markerPath = Get-RebootMarkerPath
        if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
            throw 'stage4_reboot_marker_missing'
        }

        try {
            $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
        }
        catch {
            throw 'stage4_reboot_marker_invalid'
        }

        if ([int]$marker.schemaVersion -ne 1 -or [string]$marker.sessionId -cne $SessionId) {
            throw 'stage4_reboot_marker_identity_mismatch'
        }
        if ([string]$marker.helperSha256 -cne [string]$helperProof.sha256) {
            throw 'stage4_reboot_helper_changed'
        }
        if ([string]$marker.agentSha256 -cne [string]$initialService.executable.sha256) {
            throw 'stage4_reboot_agent_changed'
        }

        $preparedAt = [DateTime]::Parse([string]$marker.preparedAt).ToUniversalTime()
        $os = Get-CimInstance Win32_OperatingSystem
        $bootAt = ([DateTime]$os.LastBootUpTime).ToUniversalTime()
        if ($bootAt -le $preparedAt) {
            throw 'stage4_reboot_not_observed'
        }

        if ($initialService.state -ne 'Running' -or [uint32]$initialService.processId -eq 0) {
            throw 'stage4_agent_not_running_after_reboot'
        }

        $oldSessionAuthorities = @(Get-AuthorityProcesses)
        if ($oldSessionAuthorities.Count -ne 0) {
            throw 'stage4_stale_authority_survived_reboot'
        }

        $oldSessionStatus = $null
        try {
            $oldSessionStatus = Invoke-HelperStatus
        }
        catch {
            $oldSessionStatus = $null
        }
        if ($null -ne $oldSessionStatus) {
            throw 'stage4_stale_session_ready_after_reboot'
        }

        $evidence.result = [ordered]@{
            localSafetyPass = $true
            overallAcceptancePendingServerEvidence = $true
            faultInjected = $true
            preparedAt = $preparedAt.ToString('o')
            bootAt = $bootAt.ToString('o')
            agentServiceAfterReboot = $initialService
            staleAuthorityRejected = $true
            staleHelperStatusRejected = $true
            manualRebootObserved = $true
        }
    }
}

$evidence.finishedAt = (Get-Date).ToUniversalTime().ToString('o')

if ([string]::IsNullOrWhiteSpace($EvidencePath)) {
    $root = Get-Stage4Root
    $EvidencePath = Join-Path $root ("windows-native-$($Scenario.ToLowerInvariant())-$SessionId.json")
}
else {
    $parentPath = Split-Path -Parent $EvidencePath
    if (-not [string]::IsNullOrWhiteSpace($parentPath)) {
        New-Item -ItemType Directory -Path $parentPath -Force | Out-Null
    }
}

[IO.File]::WriteAllText(
    $EvidencePath,
    ($evidence | ConvertTo-Json -Depth 12) + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false)
)

$evidence | ConvertTo-Json -Depth 12
