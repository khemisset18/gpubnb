param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Start', 'Finish')]
    [string]$Action,

    [string]$EvidenceDir = '',
    [string]$PcAPreflightPath = '',
    [string]$PcBPreflightPath = '',
    [string]$RedisClass = '',
    [string]$PostgresClass = '',

    [string]$BookingId = '',
    [string]$GpuProofJobId = '',
    [string]$WorkspaceSessionId = '',
    [string]$MachineId = '',
    [string]$LeasedGpuUuid = '',
    [string[]]$CorrelationIds = @(),
    [string]$PcBScreenshotPath = '',
    [string]$GpuProofEvidencePath = '',
    [string]$StateTimelinePath = '',
    [string]$FinalAvailabilityPath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Assert-SafeIdentifier {
    param([string]$Name, [string]$Value, [int]$MaxLength = 200)
    if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Name is required" }
    if ($Value.Length -gt $MaxLength -or $Value -notmatch '^[A-Za-z0-9._:-]+$') {
        throw "$Name contains unsupported characters; only non-secret IDs are accepted"
    }
}

function Read-JsonFile {
    param([string]$Path, [string]$Name)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Name file not found: $Path"
    }
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { throw "$Name is not valid JSON" }
}

function Run-External {
    param([string]$Command, [string[]]$Arguments = @())
    try {
        $raw = & $Command @Arguments 2>&1
        return [pscustomobject]@{ code = $LASTEXITCODE; text = (($raw | Out-String).Trim()) }
    } catch {
        return [pscustomobject]@{ code = 127; text = $_.Exception.Message }
    }
}

function Canonical-ResourceNames {
    param([string]$SessionId)
    $suffix = ($SessionId -replace '[^A-Za-z0-9]', '')
    if ([string]::IsNullOrWhiteSpace($suffix)) { $suffix = 'session' }
    if ($suffix.Length -gt 16) { $suffix = $suffix.Substring($suffix.Length - 16) }
    return [ordered]@{
        container = "gpubnb-dev-$suffix"
        proxy = "gpubnb-dev-proxy-$suffix"
        volume = "gpubnb-workspace-$suffix"
        network = "gpubnb-workspace-internal-$suffix"
    }
}

function List-Matching {
    param([string]$Kind)
    if ($Kind -eq 'container') {
        $r = Run-External 'docker' @('ps', '-a', '--format', '{{.Names}}')
        if ($r.code -ne 0) { throw 'docker container query failed' }
        return @($r.text -split "`r?`n" | Where-Object { $_ -like 'gpubnb-dev-*' })
    }
    if ($Kind -eq 'volume') {
        $r = Run-External 'docker' @('volume', 'ls', '--format', '{{.Name}}')
        if ($r.code -ne 0) { throw 'docker volume query failed' }
        return @($r.text -split "`r?`n" | Where-Object { $_ -like 'gpubnb-workspace-*' })
    }
    if ($Kind -eq 'network') {
        $r = Run-External 'docker' @('network', 'ls', '--format', '{{.Name}}')
        if ($r.code -ne 0) { throw 'docker network query failed' }
        return @($r.text -split "`r?`n" | Where-Object { $_ -like 'gpubnb-workspace-internal-*' })
    }
    throw "unsupported Docker resource kind: $Kind"
}

function Copy-SanitizedEvidence {
    param([string]$SourcePath, [string]$DestinationStem, [string]$Label, [string]$TargetDirectory)
    if ([string]::IsNullOrWhiteSpace($SourcePath) -or -not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
        throw "$Label file not found: $SourcePath"
    }
    $extension = [IO.Path]::GetExtension($SourcePath).ToLowerInvariant()
    $allowed = @('.json', '.txt', '.md', '.png', '.jpg', '.jpeg', '.webp')
    if ($extension -notin $allowed) {
        throw "$Label must be sanitized JSON/TXT/MD or PNG/JPG/WEBP evidence"
    }
    if ($extension -in @('.json', '.txt', '.md')) {
        $text = Get-Content -LiteralPath $SourcePath -Raw
        $secretPattern = '(?i)(authorization\s*:|cookie\s*:|redis(?:s)?://|postgres(?:ql)?://|service[_-]?role|bootstrap[_-]?grant|lease[_-]?token|BEGIN\s+(RSA|OPENSSH|EC)?\s*PRIVATE\s+KEY)'
        if ($text -match $secretPattern) {
            throw "$Label appears to contain a forbidden credential/token marker; sanitize it before collection"
        }
    }
    $destinationName = "$DestinationStem$extension"
    Copy-Item -LiteralPath $SourcePath -Destination (Join-Path $TargetDirectory $destinationName) -Force
    return $destinationName
}

if ($Action -eq 'Start') {
    if ([string]::IsNullOrWhiteSpace($RedisClass)) { throw 'RedisClass is required (provider/endpoint class only, never credentials)' }
    if ([string]::IsNullOrWhiteSpace($PostgresClass)) { throw 'PostgresClass is required (target class only, never credentials)' }
    if ($RedisClass -match '://|@|password|token|secret' -or $PostgresClass -match '://|@|password|token|secret') {
        throw 'Provider classes must not contain URLs, credentials, tokens or secrets'
    }

    $pcA = Read-JsonFile $PcAPreflightPath 'PC A preflight'
    $pcB = Read-JsonFile $PcBPreflightPath 'PC B preflight'
    if ($pcA.passed -ne $true) { throw 'PC A preflight did not pass; do not start qualification' }
    if ($pcB.passed -ne $true) { throw 'PC B preflight did not pass; do not start qualification' }

    $releaseCommit = [string]$pcA.release.repositoryCommit
    if ($releaseCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'PC A preflight is missing an exact 40-character release SHA' }
    $frontendCommit = [string]$pcB.frontend.publishedCommit
    if ($frontendCommit -notmatch '^[0-9a-fA-F]{7}$' -or -not $releaseCommit.ToLowerInvariant().StartsWith($frontendCommit.ToLowerInvariant())) {
        throw "PC A repository SHA and PC B published frontend commit disagree: $releaseCommit vs $frontendCommit"
    }

    if ([string]::IsNullOrWhiteSpace($EvidenceDir)) {
        $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
        $EvidenceDir = Join-Path (Join-Path $repoRoot 'qualification-evidence') "run-$stamp"
    }
    New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
    $EvidenceDir = (Resolve-Path $EvidenceDir).Path

    Copy-Item -LiteralPath $PcAPreflightPath -Destination (Join-Path $EvidenceDir 'pc-a-preflight.json') -Force
    Copy-Item -LiteralPath $PcBPreflightPath -Destination (Join-Path $EvidenceDir 'pc-b-preflight.json') -Force

    $record = [ordered]@{
        schemaVersion = 1
        kind = 'gpubnb-current-release-physical-qualification'
        status = 'IN_PROGRESS'
        startedAtUtc = [DateTime]::UtcNow.ToString('o')
        endedAtUtc = $null
        release = [ordered]@{
            gitCommit = $releaseCommit
            frontendCommit = $frontendCommit
            agentVersion = [string]$pcA.agent.version
            agentBuildCommit = [string]$pcA.agent.buildCommit
            agentFrozen = [bool]$pcA.agent.frozen
            frontendOrigin = [string]$pcB.origins.frontend
            apiOrigin = [string]$pcB.origins.api
            gatewayOrigin = [string]$pcB.origins.gateway
            redisClass = $RedisClass
            postgresClass = $PostgresClass
        }
        host = [ordered]@{
            machineId = [string]$pcA.agent.machineId
            os = [string]$pcA.host.os
            dockerServerVersion = [string]$pcA.host.dockerServerVersion
            targetGpu = $pcA.host.targetGpu
        }
        rental = [ordered]@{
            bookingId = $null
            gpuProofJobId = $null
            workspaceSessionId = $null
            leasedGpuUuid = $null
            correlationIds = @()
        }
        evidenceFiles = $null
        cleanup = $null
        decision = 'PENDING_MANUAL_REVIEW'
    }
    $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $EvidenceDir 'qualification-run.json') -Encoding UTF8

    $lock = [ordered]@{
        gitCommit = $releaseCommit
        frontendCommit = $frontendCommit
        agentVersion = [string]$pcA.agent.version
        agentBuildCommit = [string]$pcA.agent.buildCommit
        machineId = [string]$pcA.agent.machineId
        os = [string]$pcA.host.os
        dockerServerVersion = [string]$pcA.host.dockerServerVersion
        targetGpuUuid = [string]$pcA.host.targetGpu.uuid
        targetGpuName = [string]$pcA.host.targetGpu.name
        nvidiaDriverVersion = [string]$pcA.host.targetGpu.driverVersion
        frontendOrigin = [string]$pcB.origins.frontend
        apiOrigin = [string]$pcB.origins.api
        gatewayOrigin = [string]$pcB.origins.gateway
        lockedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    $lock | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceDir 'release-lock.json') -Encoding UTF8

    @"
# GPUbnb current-release physical qualification

Status: **IN PROGRESS — NOT PASSED**

Release SHA: `$releaseCommit`
Agent: `$($pcA.agent.version)` / build `$($pcA.agent.buildCommit)`
Machine: `$($pcA.agent.machineId)`
Host OS: `$($pcA.host.os)`
Docker server: `$($pcA.host.dockerServerVersion)`
Target GPU: `$($pcA.host.targetGpu.uuid)` — `$($pcA.host.targetGpu.name)`
NVIDIA driver: `$($pcA.host.targetGpu.driverVersion)`
Frontend: `$($pcB.origins.frontend)`
API: `$($pcB.origins.api)`
Gateway: `$($pcB.origins.gateway)`
UTC start: `$($record.startedAtUtc)`

Do not change any executable component or public origin during this clean run. If one changes, discard this run and start a new qualification.
"@ | Set-Content -LiteralPath (Join-Path $EvidenceDir 'RESULT.md') -Encoding UTF8

    Write-Host "Qualification evidence directory: $EvidenceDir"
    Write-Host "Release locked at: $releaseCommit"
    Write-Host 'Both preflights passed. You may now start the clean PC A <-> PC B rental.'
    exit 0
}

# Finish
if ([string]::IsNullOrWhiteSpace($EvidenceDir)) { throw 'EvidenceDir is required for Finish' }
$EvidenceDir = (Resolve-Path $EvidenceDir).Path
$runPath = Join-Path $EvidenceDir 'qualification-run.json'
$record = Read-JsonFile $runPath 'qualification run'
if ($record.status -ne 'IN_PROGRESS') { throw "qualification run is not IN_PROGRESS: $($record.status)" }

Assert-SafeIdentifier 'BookingId' $BookingId
Assert-SafeIdentifier 'GpuProofJobId' $GpuProofJobId
Assert-SafeIdentifier 'WorkspaceSessionId' $WorkspaceSessionId
Assert-SafeIdentifier 'MachineId' $MachineId
Assert-SafeIdentifier 'LeasedGpuUuid' $LeasedGpuUuid
if ($CorrelationIds.Count -lt 1) { throw 'At least one sanitized CorrelationId is required' }
foreach ($correlationId in $CorrelationIds) { Assert-SafeIdentifier 'CorrelationId' $correlationId }
if ([string]::IsNullOrWhiteSpace($PcBScreenshotPath)) { throw 'PcBScreenshotPath is required for the renter nvidia-smi evidence' }
if ([string]::IsNullOrWhiteSpace($GpuProofEvidencePath)) { throw 'GpuProofEvidencePath is required' }
if ([string]::IsNullOrWhiteSpace($StateTimelinePath)) { throw 'StateTimelinePath is required' }
if ([string]::IsNullOrWhiteSpace($FinalAvailabilityPath)) { throw 'FinalAvailabilityPath is required' }

if ($MachineId -ne [string]$record.host.machineId) {
    throw "MachineId does not match the release lock: expected $($record.host.machineId), got $MachineId"
}
if ($LeasedGpuUuid -ine [string]$record.host.targetGpu.uuid) {
    throw "Leased GPU UUID does not match the preflight target: expected $($record.host.targetGpu.uuid), got $LeasedGpuUuid"
}

$names = Canonical-ResourceNames $WorkspaceSessionId
$containers = List-Matching 'container'
$volumes = List-Matching 'volume'
$networks = List-Matching 'network'
$exactLeftovers = @()
if ($containers -contains $names.container) { $exactLeftovers += $names.container }
if ($containers -contains $names.proxy) { $exactLeftovers += $names.proxy }
if ($volumes -contains $names.volume) { $exactLeftovers += $names.volume }
if ($networks -contains $names.network) { $exactLeftovers += $names.network }
$allClean = $containers.Count -eq 0 -and $volumes.Count -eq 0 -and $networks.Count -eq 0 -and $exactLeftovers.Count -eq 0

$nvidia = Run-External 'nvidia-smi' @('--query-gpu=uuid,name,driver_version', '--format=csv,noheader')
$targetStillPresent = $nvidia.code -eq 0 -and $nvidia.text.ToLowerInvariant().Contains($LeasedGpuUuid.ToLowerInvariant())

$pcBEvidenceName = Copy-SanitizedEvidence $PcBScreenshotPath 'pc-b-nvidia-smi' 'PC B nvidia-smi evidence' $EvidenceDir
$gpuProofEvidenceName = Copy-SanitizedEvidence $GpuProofEvidencePath 'gpu-proof-evidence' 'GPU_PROOF evidence' $EvidenceDir
$timelineEvidenceName = Copy-SanitizedEvidence $StateTimelinePath 'state-transition-timeline' 'state transition timeline' $EvidenceDir
$availabilityEvidenceName = Copy-SanitizedEvidence $FinalAvailabilityPath 'final-availability' 'final GPU/listing availability evidence' $EvidenceDir

$record.status = 'EVIDENCE_COLLECTED'
$record.endedAtUtc = [DateTime]::UtcNow.ToString('o')
$record.rental.bookingId = $BookingId
$record.rental.gpuProofJobId = $GpuProofJobId
$record.rental.workspaceSessionId = $WorkspaceSessionId
$record.rental.leasedGpuUuid = $LeasedGpuUuid
$record.rental.correlationIds = @($CorrelationIds)
$record.evidenceFiles = [ordered]@{
    pcBNvidiaSmi = $pcBEvidenceName
    gpuProof = $gpuProofEvidenceName
    stateTimeline = $timelineEvidenceName
    finalAvailability = $availabilityEvidenceName
}
$record.cleanup = [ordered]@{
    expectedResources = $names
    exactLeftovers = $exactLeftovers
    allPerSessionContainers = $containers
    allPerSessionVolumes = $volumes
    allPerSessionInternalNetworks = $networks
    clean = $allClean
    targetGpuStillPresent = $targetStillPresent
}
$record.decision = 'PENDING_MANUAL_REVIEW'
$record | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $runPath -Encoding UTF8

$cleanupText = if ($allClean) { 'PASS — no GPUbnb per-session Docker resources remain' } else { 'FAIL — unexpected GPUbnb per-session Docker resources remain' }
$gpuPresentText = if ($targetStillPresent) { 'PASS — leased physical GPU UUID is still present on PC A after cleanup' } else { 'FAIL — target GPU UUID was not observed after cleanup' }

@"
# GPUbnb current-release physical qualification evidence

Status: **EVIDENCE COLLECTED — MANUAL PASS DECISION STILL REQUIRED**

This collector never marks the release PASSED by itself. `docs/CURRENT_PHYSICAL_QUALIFICATION.md` remains authoritative.

## Locked release identity

- Git SHA: `$($record.release.gitCommit)`
- Frontend build: `$($record.release.frontendCommit)`
- Agent: `$($record.release.agentVersion)` / build `$($record.release.agentBuildCommit)`
- Machine: `$MachineId`
- Host OS: `$($record.host.os)`
- Docker server: `$($record.host.dockerServerVersion)`
- GPU: `$LeasedGpuUuid` — `$($record.host.targetGpu.name)`
- NVIDIA driver: `$($record.host.targetGpu.driverVersion)`
- Frontend: `$($record.release.frontendOrigin)`
- API: `$($record.release.apiOrigin)`
- Gateway: `$($record.release.gatewayOrigin)`
- Redis class: `$($record.release.redisClass)`
- PostgreSQL class: `$($record.release.postgresClass)`
- UTC start: `$($record.startedAtUtc)`
- UTC end: `$($record.endedAtUtc)`

## Rental identifiers

- Booking ID: `$BookingId`
- GPU_PROOF job ID: `$GpuProofJobId`
- Workspace session ID: `$WorkspaceSessionId`
- Leased accelerator hardware UUID: `$LeasedGpuUuid`
- Correlation IDs: `$([string]::Join(', ', @($CorrelationIds)))`

## Evidence files

- PC B `nvidia-smi`: `$pcBEvidenceName`
- GPU_PROOF evidence: `$gpuProofEvidenceName`
- State transition timeline: `$timelineEvidenceName`
- Final GPU/listing availability: `$availabilityEvidenceName`

## Automatically collected checks

- PC A preflight: PASS
- PC B public-path preflight: PASS
- Machine ID matches release lock: PASS
- Leased GPU UUID matches PC A target: PASS
- Docker cleanup: `$cleanupText`
- Physical GPU still visible after cleanup: `$gpuPresentText`
- Required sanitized evidence files: PRESENT

## Mandatory manual review before changing the gate to PASSED

- [ ] Server evidence proves GPU_PROOF completed on the leased hardware UUID.
- [ ] Developer preparation started only after GPU_PROOF success.
- [ ] Exactly one Developer runtime and one gateway registration existed for the session.
- [ ] PC B saw **Ouvrir mon espace** only while `canOpen` was truly satisfied.
- [ ] PC B opened the actual code-server workspace through the configured public gateway.
- [ ] The sanitized PC B evidence visibly proves `nvidia-smi` reports the exact leased GPU.
- [ ] Healthy activity/liveness stayed stable for the required observation window.
- [ ] Normal stop completed with clean booking/workspace/job terminal states and no unexpected quarantine.
- [ ] Runtime-cleanliness evidence reports no orphan.
- [ ] The GPU resource and listing became available/bookable again only after cleanup/release.
- [ ] No secret (cookie, authorization header, Redis/Supabase credential, bootstrap grant, lease token, private key, signed auth payload) appears in this evidence directory.

If any checkbox fails, the qualification is FAILED, not partially passed.
"@ | Set-Content -LiteralPath (Join-Path $EvidenceDir 'RESULT.md') -Encoding UTF8

Write-Host "Updated evidence: $(Join-Path $EvidenceDir 'RESULT.md')"
if (-not $allClean -or -not $targetStillPresent) {
    Write-Error 'Automatic cleanup/GPU checks FAILED. Physical qualification cannot pass.'
    exit 1
}
Write-Host 'Automatic evidence collection passed. Manual gate review is still required before declaring PASSED.'
exit 0
