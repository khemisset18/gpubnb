param(
    [string]$ExpectedReleaseCommit = "",
    [string]$ExpectedAgentCommit = "",
    [string]$ExpectedGpuUuid = "",
    [string]$OutputPath = ""
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$startedAt = [DateTime]::UtcNow
$checks = New-Object System.Collections.Generic.List[object]

function Add-Check {
    param([string]$Name, [bool]$Passed, [string]$Detail)
    $checks.Add([pscustomobject]@{ name = $Name; passed = $Passed; detail = $Detail }) | Out-Null
    $prefix = if ($Passed) { '[PASS]' } else { '[FAIL]' }
    Write-Host "$prefix $Name - $Detail"
}

function Run-External {
    param([string]$Command, [string[]]$Arguments = @())
    try {
        $raw = & $Command @Arguments 2>&1
        $code = $LASTEXITCODE
        return [pscustomobject]@{ code = $code; text = (($raw | Out-String).Trim()) }
    } catch {
        return [pscustomobject]@{ code = 127; text = $_.Exception.Message }
    }
}

function Commit-Matches {
    param([string]$Actual, [string]$Expected)
    if ([string]::IsNullOrWhiteSpace($Expected)) { return $true }
    $a = $Actual.Trim().ToLowerInvariant()
    $e = $Expected.Trim().ToLowerInvariant()
    return $a.StartsWith($e) -or $e.StartsWith($a)
}

function Safe-Origin {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    try { return ([Uri]$Value).GetLeftPart([System.UriPartial]::Authority) } catch { return $null }
}

$gitHead = Run-External 'git' @('-C', $repoRoot, 'rev-parse', 'HEAD')
if ($gitHead.code -eq 0 -and $gitHead.text -match '^[0-9a-fA-F]{40}$') {
    Add-Check 'release git SHA' $true $gitHead.text
} else {
    Add-Check 'release git SHA' $false 'unable to resolve exact repository commit'
}

$gitStatus = Run-External 'git' @('-C', $repoRoot, 'status', '--porcelain')
$gitClean = $gitStatus.code -eq 0 -and [string]::IsNullOrWhiteSpace($gitStatus.text)
Add-Check 'repository is clean' $gitClean $(if ($gitClean) { 'no uncommitted files' } else { 'working tree is dirty; do not qualify an ambiguous release' })

if (-not [string]::IsNullOrWhiteSpace($ExpectedReleaseCommit) -and $gitHead.code -eq 0) {
    $match = Commit-Matches $gitHead.text $ExpectedReleaseCommit
    Add-Check 'expected release SHA' $match $(if ($match) { $ExpectedReleaseCommit } else { "expected $ExpectedReleaseCommit, got $($gitHead.text)" })
}

$agentVersionResult = Run-External 'gpubnb-agent' @('version')
$agentVersion = if ($agentVersionResult.code -eq 0) { $agentVersionResult.text.Trim() } else { '' }
Add-Check 'Agent version' ($agentVersionResult.code -eq 0 -and $agentVersion.Length -gt 0) $(if ($agentVersion) { $agentVersion } else { 'gpubnb-agent version failed' })

$agentBuildResult = Run-External 'gpubnb-agent' @('build-info')
$agentBuild = $null
if ($agentBuildResult.code -eq 0) {
    try { $agentBuild = $agentBuildResult.text | ConvertFrom-Json } catch { $agentBuild = $null }
}
$agentBuildOk = $null -ne $agentBuild -and $agentBuild.frozen -eq $true -and -not [string]::IsNullOrWhiteSpace([string]$agentBuild.buildCommit)
Add-Check 'Agent immutable build identity' $agentBuildOk $(if ($agentBuildOk) { "commit=$($agentBuild.buildCommit), frozen=true" } else { 'build-info must report a frozen release build with buildCommit' })

if (-not [string]::IsNullOrWhiteSpace($ExpectedAgentCommit) -and $agentBuildOk) {
    $match = Commit-Matches ([string]$agentBuild.buildCommit) $ExpectedAgentCommit
    Add-Check 'expected Agent build commit' $match $(if ($match) { $ExpectedAgentCommit } else { "expected $ExpectedAgentCommit, got $($agentBuild.buildCommit)" })
}

$agentStatusResult = Run-External 'gpubnb-agent' @('status')
$agentStatus = $null
if ($agentStatusResult.code -eq 0) {
    try { $agentStatus = $agentStatusResult.text | ConvertFrom-Json } catch { $agentStatus = $null }
}
$agentRunning = $null -ne $agentStatus -and $agentStatus.running -eq $true -and -not [string]::IsNullOrWhiteSpace([string]$agentStatus.machineId)
Add-Check 'Agent running and linked' $agentRunning $(if ($agentRunning) { "machineId=$($agentStatus.machineId)" } else { 'status must report running=true and a machineId' })

$runtimeCheck = Run-External 'gpubnb-agent' @('runtime-check')
Add-Check 'Agent runtime check' ($runtimeCheck.code -eq 0) $(if ($runtimeCheck.code -eq 0) { 'runtime-check passed' } else { 'runtime-check failed' })

$diagnose = Run-External 'gpubnb-agent' @('diagnose')
Add-Check 'Agent GPU/Docker/API/link diagnostic' ($diagnose.code -eq 0) $(if ($diagnose.code -eq 0) { 'diagnose passed' } else { 'diagnose failed; inspect console output before qualification' })

$dockerVersionResult = Run-External 'docker' @('version', '--format', '{{.Server.Version}}')
$dockerVersion = if ($dockerVersionResult.code -eq 0) { $dockerVersionResult.text.Trim() } else { '' }
Add-Check 'Docker daemon' ($dockerVersionResult.code -eq 0 -and $dockerVersion.Length -gt 0) $(if ($dockerVersion) { "server=$dockerVersion" } else { 'Docker daemon unavailable' })

$nvidiaResult = Run-External 'nvidia-smi' @('--query-gpu=uuid,name,driver_version,memory.total', '--format=csv,noheader,nounits')
$gpus = @()
if ($nvidiaResult.code -eq 0 -and -not [string]::IsNullOrWhiteSpace($nvidiaResult.text)) {
    foreach ($line in ($nvidiaResult.text -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line -split ',\s*', 4
        if ($parts.Count -eq 4) {
            $gpus += [pscustomobject]@{
                uuid = $parts[0].Trim()
                name = $parts[1].Trim()
                driverVersion = $parts[2].Trim()
                memoryTotalMiB = $parts[3].Trim()
            }
        }
    }
}
Add-Check 'NVIDIA inventory' ($gpus.Count -gt 0) $(if ($gpus.Count -gt 0) { "$($gpus.Count) physical GPU(s) detected" } else { 'nvidia-smi did not return a usable GPU inventory' })

$targetGpu = $null
if ($gpus.Count -eq 1 -and [string]::IsNullOrWhiteSpace($ExpectedGpuUuid)) {
    $targetGpu = $gpus[0]
} elseif (-not [string]::IsNullOrWhiteSpace($ExpectedGpuUuid)) {
    $targetGpu = $gpus | Where-Object { $_.uuid -ieq $ExpectedGpuUuid } | Select-Object -First 1
}
$targetOk = $null -ne $targetGpu
$targetDetail = if ($targetOk) { "$($targetGpu.uuid) / $($targetGpu.name)" } elseif ($gpus.Count -gt 1 -and [string]::IsNullOrWhiteSpace($ExpectedGpuUuid)) { 'multiple GPUs present: pass -ExpectedGpuUuid to lock the qualification target' } else { "target GPU not found: $ExpectedGpuUuid" }
Add-Check 'qualification target GPU UUID' $targetOk $targetDetail

$containersResult = Run-External 'docker' @('ps', '-a', '--format', '{{.Names}}')
$volumesResult = Run-External 'docker' @('volume', 'ls', '--format', '{{.Name}}')
$networksResult = Run-External 'docker' @('network', 'ls', '--format', '{{.Name}}')
$containers = if ($containersResult.code -eq 0) { @($containersResult.text -split "`r?`n" | Where-Object { $_ -like 'gpubnb-dev-*' }) } else { @('__docker_query_failed__') }
$volumes = if ($volumesResult.code -eq 0) { @($volumesResult.text -split "`r?`n" | Where-Object { $_ -like 'gpubnb-workspace-*' }) } else { @('__docker_query_failed__') }
$networks = if ($networksResult.code -eq 0) { @($networksResult.text -split "`r?`n" | Where-Object { $_ -like 'gpubnb-workspace-internal-*' }) } else { @('__docker_query_failed__') }
$runtimeClean = $containers.Count -eq 0 -and $volumes.Count -eq 0 -and $networks.Count -eq 0
$runtimeDetail = if ($runtimeClean) { 'no per-session GPUbnb container/proxy/volume/internal network exists before the run' } else { "containers=$($containers.Count), volumes=$($volumes.Count), internalNetworks=$($networks.Count)" }
Add-Check 'clean Docker baseline' $runtimeClean $runtimeDetail

$failed = @($checks | Where-Object { -not $_.passed })
$result = [ordered]@{
    schemaVersion = 1
    kind = 'gpubnb-physical-qualification-pc-a-preflight'
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    passed = ($failed.Count -eq 0)
    release = [ordered]@{
        repositoryCommit = if ($gitHead.code -eq 0) { $gitHead.text } else { $null }
        expectedReleaseCommit = if ($ExpectedReleaseCommit) { $ExpectedReleaseCommit } else { $null }
        repositoryClean = $gitClean
    }
    agent = [ordered]@{
        version = if ($agentVersion) { $agentVersion } else { $null }
        buildCommit = if ($agentBuildOk) { [string]$agentBuild.buildCommit } else { $null }
        frozen = if ($null -ne $agentBuild) { [bool]$agentBuild.frozen } else { $false }
        machineId = if ($agentRunning) { [string]$agentStatus.machineId } else { $null }
        running = $agentRunning
    }
    host = [ordered]@{
        os = [Environment]::OSVersion.VersionString
        dockerServerVersion = if ($dockerVersion) { $dockerVersion } else { $null }
        targetGpu = $targetGpu
        gpus = $gpus
    }
    dockerBaseline = [ordered]@{
        perSessionContainers = $containers
        perSessionVolumes = $volumes
        perSessionInternalNetworks = $networks
    }
    checks = $checks
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $stamp = $startedAt.ToString('yyyyMMddTHHmmssZ')
    $evidenceRoot = Join-Path $repoRoot 'qualification-evidence'
    New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
    $OutputPath = Join-Path $evidenceRoot "pc-a-preflight-$stamp.json"
} else {
    $parent = Split-Path -Parent $OutputPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
}
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Host "Evidence: $OutputPath"

if ($failed.Count -gt 0) {
    Write-Error "PC A preflight FAILED ($($failed.Count) check(s)). Do not start the physical rental."
    exit 1
}
Write-Host 'PC A preflight PASSED. Keep this exact release/Agent/GPU identity unchanged for the clean run.'
exit 0
