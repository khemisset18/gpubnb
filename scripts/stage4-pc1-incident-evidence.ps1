#Requires -Version 5.1
# Read existing evidence only. Never execute GPUbnb binaries or change Host state.
[CmdletBinding()]
param(
    [string]$StateDirectory = (Join-Path $env:ProgramData 'GPUbnb'),
    [switch]$FunctionsOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-IncidentField($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function Get-IncidentTag([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant().Substring(0, 16) }
    finally { $sha.Dispose() }
}

function Assert-IncidentRegularPath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'incident_reparse_path' }
        }
        $current = Split-Path -Parent $current
    }
}

function Read-IncidentResourceState([string]$Path, [bool]$Rental) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @{ present = $false; records = @(); status = 'absent' } }
    try {
        Assert-IncidentRegularPath $Path
        if ((Get-Item -LiteralPath $Path).Length -gt 1048576) { throw 'incident_state_too_large' }
        $bytes = [IO.File]::ReadAllBytes($Path)
        $value = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) | ConvertFrom-Json
        $resources = Get-IncidentField $value 'resources'
        if ((Get-IncidentField $value 'schemaVersion') -ne 1 -or $resources -isnot [PSCustomObject]) { throw 'incident_invalid_schema' }
        $records = @()
        foreach ($entry in $resources.PSObject.Properties) {
            if ($records.Count -ge 64) { throw 'incident_excessive_records' }
            $record = $entry.Value
            $state = [string](Get-IncidentField $record 'state')
            if ($state -cnotin @('PREEMPTING', 'QUIESCENT', 'RENTAL_ACTIVE', 'QUARANTINED', 'MINING', 'STOPPED')) { throw 'incident_invalid_state' }
            $generation = 0L
            if (-not [long]::TryParse([string](Get-IncidentField $record 'runtime_generation'), [ref]$generation) -or $generation -lt 0) { throw 'incident_invalid_generation' }
            $row = [ordered]@{
                resourceTag = Get-IncidentTag $entry.Name
                gpuTag = Get-IncidentTag ([string](Get-IncidentField $record 'hardware_uuid'))
                state = $state; generation = $generation
                processIdentityPresent = ($null -ne (Get-IncidentField $record 'pid') -or [bool](Get-IncidentField $record 'process_creation_token'))
            }
            if ($Rental) {
                $session = [string](Get-IncidentField $record 'session_id')
                $row.sessionTag = Get-IncidentTag $session
                $row.holderMatchesSession = (Get-IncidentField $record 'holder_id') -ceq ('rental:' + $session)
                $row.fenceMatchesGeneration = (Get-IncidentField $record 'fencing_token') -ceq [string]$generation
            }
            $records += $row
        }
        return @{ present = $true; status = 'observed'; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant(); records = $records }
    } catch { return @{ present = $true; status = 'unreadable_or_invalid'; records = @() } }
}

function Select-IncidentLifecycleCodes([string[]]$Lines) {
    # Never output raw log lines: they can include paths, URLs or capabilities.
    $allowed = 'virtual_display(?:_interface_query|_interface_missing|_interface_ambiguous|_control_open|_control|_gate|_busy|_access_denied|_invalid_request|_not_ready)?|rental_gpu_compute_processes_present|rental_gpu_utilization_not_quiescent|rental_gpu_memory_not_quiescent|native_session_cleanup_failed|native_workspace_stop_unconfirmed|windows_native_start_cleanup_unverified|native_stream_self_test_failed|native_rental_fenced|native_gpu_runtime_fenced|native_resource_state_unverified|native_start_begin|native_specs_ready|native_preempt_begin|native_preempt_quiescent|native_helper_start_begin|native_helper_start_failed|native_helper_start_ready|native_runtime_ready|native_release_deferred|native_release_failed|native_stop_without_handle_failed|native_stale_claim_cleanup_failed|native_stale_claim_quiescence_failed|native_stale_quarantine_recovered'
    $rows = @()
    $allowed += '|native_cleanup_(?:prepared|completed|not_prepared|authority_refused|authority_changed|scope_unverified|fence_unverified|windows_required|claim_authority_unverified|runtime_authority_unverified|runtime_process_unverified|runtime_fence_regressed|gpu_binding_mismatch|local_authority_changed|release_unverified|assignment_unverified|docker_resources_present|diagnostic_gpu_mismatch)'
    foreach ($line in $Lines) {
        foreach ($match in [regex]::Matches($line, '(?<![A-Za-z0-9_])(?:' + $allowed + ')(?![A-Za-z0-9_])')) {
            $timestamp = [regex]::Match($line, '^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?').Value
            $rows += @{ timestamp = $timestamp; code = $match.Value }
        }
    }
    return @($rows | Select-Object -Last 120)
}

if ($FunctionsOnly) { return }
if ($env:OS -cne 'Windows_NT') { throw 'incident_windows_required' }
$report = [ordered]@{
    kind = 'STAGE4_READ_ONLY_INCIDENT_EVIDENCE'; schemaVersion = 1
    observedAtUtc = [DateTime]::UtcNow.ToString('o')
    rental = Read-IncidentResourceState (Join-Path $StateDirectory 'gpu-resource-rental-v1.json') $true
    runtime = Read-IncidentResourceState (Join-Path $StateDirectory 'gpu-resource-runtime-v1.json') $false
    physicalTestPerformed = $false; installationPerformed = $false; recoveryPerformed = $false
    installDecision = 'BLOCKED_pending_identity_signing_rank_and_cleanup_proof'
}
try {
    $device = Get-PnpDevice -PresentOnly -InstanceId 'ROOT\DISPLAY\0000'
    $ids = @(Get-PnpDeviceProperty -InstanceId $device.InstanceId -KeyName 'DEVPKEY_Device_HardwareIds')
    $drivers = @(Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceID -ieq 'ROOT\DISPLAY\0000' })
    $report.device = @{
        expectedHardwareIdMatches = (@($ids.Data) -icontains 'Root\GPUbnbVirtualDisplay')
        status = [string]$device.Status
        drivers = @($drivers | Select-Object InfName, DriverVersion, DriverDate, DriverProviderName, IsSigned, Signer)
    }
} catch { $report.device = @{ status = 'identity_unverified' } }
try { $report.secureBootEnabled = [bool](Confirm-SecureBootUEFI) }
catch { $report.secureBootStatus = 'unverified' }
try {
    $log = Join-Path $StateDirectory 'agent.log'
    Assert-IncidentRegularPath $log
    $report.lifecycleCodes = @(Select-IncidentLifecycleCodes @(Get-Content -LiteralPath $log -Tail 3000))
} catch { $report.logStatus = 'unavailable'; $report.lifecycleCodes = @() }
$report | ConvertTo-Json -Depth 10
