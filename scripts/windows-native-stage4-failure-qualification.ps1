#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Preflight', 'HelperCrash', 'AgentRestart')]
    [string]$Scenario,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9_-]{1,200}$')]
    [string]$SessionId,

    [string]$HelperPath = "$env:ProgramFiles\GPUbnb\gpubnb-windows-stream.exe",
    [string]$ServiceName = 'GPUbnbAgent',

    [ValidateRange(15, 300)]
    [int]$RecoveryTimeoutSeconds = 90,

    [switch]$ArmFaults,

    [string]$EvidencePath
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
        if ($command -notmatch "(?i)(^|\s)--session-id\s+`"?$escapedSession`"?(\s|$)") {
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

Assert-Administrator
$script:HelperCanonical = Resolve-CanonicalFile -Path $HelperPath
$helperProof = Get-SignedFileProof -Path $script:HelperCanonical
$initialStatus = Invoke-HelperStatus
if ($null -eq $initialStatus -or $initialStatus.suspended -eq $true) {
    throw 'stage4_helper_not_ready_before_fault'
}
$initialAuthority = Get-SingleAuthorityProcess
$initialService = Get-ServiceProof

$startedAt = (Get-Date).ToUniversalTime()
$evidence = [ordered]@{
    schemaVersion = 1
    scenario = $Scenario
    sessionId = $SessionId
    startedAt = $startedAt.ToString('o')
    helper = $helperProof
    initial = [ordered]@{
        authorityPid = [uint32]$initialAuthority.ProcessId
        helperStatus = $initialStatus
        agentService = $initialService
    }
    result = $null
}

switch ($Scenario) {
    'Preflight' {
        $evidence.result = [ordered]@{
            pass = $true
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

        $recovered = Wait-For -FailureCode 'stage4_helper_recovery_timeout' -Probe {
            try {
                $process = Get-SingleAuthorityProcess
                if ([uint32]$process.ProcessId -eq $oldPid) { return $null }
                $status = Invoke-HelperStatus
                if ($null -eq $status -or $status.suspended -eq $true -or $status.mediaReady -ne $true) {
                    return $null
                }
                return [ordered]@{
                    authorityPid = [uint32]$process.ProcessId
                    helperStatus = $status
                }
            }
            catch {
                return $null
            }
        }

        $evidence.result = [ordered]@{
            pass = $true
            faultInjected = $true
            oldAuthorityPid = $oldPid
            newAuthorityPid = $recovered.authorityPid
            recoveredHelperStatus = $recovered.helperStatus
            displayRecreatedByFreshAuthority = $true
        }
    }

    'AgentRestart' {
        Assert-FaultsArmed
        $service = Get-Service -Name $ServiceName -ErrorAction Stop
        if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Running) {
            throw 'stage4_agent_not_running_before_restart'
        }

        $beforePid = [uint32](Get-ServiceProof).processId
        Stop-Service -Name $ServiceName -ErrorAction Stop
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

        $recoveredStatus = Wait-For -FailureCode 'stage4_helper_not_ready_after_agent_restart' -Probe {
            try {
                $status = Invoke-HelperStatus
                if ($null -eq $status -or $status.suspended -eq $true -or $status.mediaReady -ne $true) {
                    return $null
                }
                return $status
            }
            catch {
                return $null
            }
        }

        $afterAuthority = Get-SingleAuthorityProcess
        $evidence.result = [ordered]@{
            pass = $true
            faultInjected = $true
            oldAgentPid = $beforePid
            newAgentPid = [uint32]$afterService.processId
            authorityPidAfterRestart = [uint32]$afterAuthority.ProcessId
            recoveredHelperStatus = $recoveredStatus
        }
    }
}

$evidence.finishedAt = (Get-Date).ToUniversalTime().ToString('o')

if ([string]::IsNullOrWhiteSpace($EvidencePath)) {
    $root = Join-Path $env:ProgramData 'GPUbnb\qualification\stage4'
    New-Item -ItemType Directory -Path $root -Force | Out-Null
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
