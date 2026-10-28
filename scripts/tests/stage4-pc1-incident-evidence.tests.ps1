#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\stage4-pc1-incident-evidence.ps1') -FunctionsOnly -StateDirectory $PSScriptRoot
$root = Join-Path ([IO.Path]::GetTempPath()) ('gpubnb-incident-test-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
try {
    $file = Join-Path $root 'claims.json'
    $fixture = '{"schemaVersion":1,"resources":{"resource_one":{"session_id":"private-session","hardware_uuid":"GPU-aaaaaaaa","runtime_generation":90,"holder_id":"rental:private-session","lease_id":"private-lease","fencing_token":"90","state":"QUARANTINED"}}}'
    [IO.File]::WriteAllText($file, $fixture, [Text.UTF8Encoding]::new($false))
    $before = (Get-FileHash -LiteralPath $file).Hash
    $state = Read-IncidentResourceState $file $true
    if ($state.status -cne 'observed' -or $state.records.Count -ne 1 -or $state.records[0].state -cne 'QUARANTINED' -or -not $state.records[0].fenceMatchesGeneration -or -not $state.records[0].holderMatchesSession) { throw 'incident_claim_fixture_failed' }
    if (($state | ConvertTo-Json -Depth 8) -match 'private-session|private-lease|GPU-aaaaaaaa|resource_one') { throw 'incident_identifiers_not_scrubbed' }
    if ((Get-FileHash -LiteralPath $file).Hash -cne $before) { throw 'incident_evidence_was_modified' }
    $rows = @(Select-IncidentLifecycleCodes @('2026-10-26 12:00:01 workspace_trace:native_helper_start_failed:session=SECRET:code=virtual_display_control_open path=C:\Users\SECRET token=SECRET', 'not_virtual_display_busy_secret', '2026-10-26 12:00:02 rental_gpu_compute_processes_present'))
    if ($rows.Count -ne 3 -or ($rows | ConvertTo-Json) -match 'SECRET|Users|session=') { throw 'incident_log_scrubbing_failed' }
    $cleanupRows = @(Select-IncidentLifecycleCodes @('windows_native_runtime_start_failed:native_workspace_start_failed:virtual_display_interface_ambiguous_cleanup_unverified token=SECRET', 'virtual_display_busy_cleanup_unverified_secret'))
    if ($cleanupRows.Count -ne 1 -or $cleanupRows[0].code -cne 'virtual_display_interface_ambiguous_cleanup_unverified' -or ($cleanupRows | ConvertTo-Json) -match 'SECRET|token') { throw 'incident_cleanup_cause_lost_or_unscrubbed' }
    $recoveryRows = @(Select-IncidentLifecycleCodes @('{"event":"native_cleanup_completed","sessionId":"SECRET","hardwareUuid":"SECRET"}', 'native_cleanup_authority_refused capability=SECRET', 'native_cleanup_unknown_secret'))
    if ($recoveryRows.Count -ne 2 -or ($recoveryRows | ConvertTo-Json) -match 'SECRET|sessionId|hardwareUuid|capability|unknown') { throw 'incident_recovery_log_scrubbing_failed' }
    [IO.File]::WriteAllBytes($file, [byte[]]@(255, 254, 255))
    if ((Read-IncidentResourceState $file $true).status -cne 'unreadable_or_invalid') { throw 'incident_invalid_utf8_not_blocked' }
    [IO.File]::WriteAllText($file, '{"schemaVersion":2,"resources":{}}')
    if ((Read-IncidentResourceState $file $true).status -cne 'unreadable_or_invalid') { throw 'incident_invalid_schema_not_blocked' }
    if ((Read-IncidentResourceState (Join-Path $root 'absent.json') $true).status -cne 'absent') { throw 'incident_absent_state_failed' }
    Write-Host 'PASS incident fixtures: read-only, bounded, scrubbed, corrupt state fails closed'
} finally { [IO.Directory]::Delete($root, $true) }
