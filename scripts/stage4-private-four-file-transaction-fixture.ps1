#Requires -Version 5.1
# TEMP-only Windows transaction simulator. NO real service or PC1 modifications.
Set-StrictMode -Version Latest

function Invoke-Stage4TemporaryTransaction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$FixtureRoot,
        [Parameter(Mandatory=$true)][scriptblock]$StopFakeService,
        [Parameter(Mandatory=$true)][scriptblock]$StartFakeService,
        [Parameter(Mandatory=$true)][scriptblock]$IsFakeRunning,
        [Parameter(Mandatory=$true)][scriptblock]$IsFakeStopped,
        [Parameter(Mandatory=$true)][scriptblock]$CheckFakeHealth,
        [ValidateRange(0,4)][int]$FailAfterFile=0
    )
    if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
        throw 'stage4_fixture_requires_windows_x64'
    }
    $root=[IO.Path]::GetFullPath($FixtureRoot).TrimEnd('\')
    $temp=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
    $candidate=Join-Path $root 'candidate'
    $installed=Join-Path $root 'installed'
    if ((Split-Path -Parent $root) -ine $temp -or
        (Split-Path -Leaf $root) -cnotmatch '^GPUbnb-stage4-transaction-test-[a-f0-9]{32}$' -or
        -not (Test-Path -LiteralPath $candidate -PathType Container) -or
        -not (Test-Path -LiteralPath $installed -PathType Container)) {
        throw 'stage4_fixture_refuses_real_installation'
    }
    foreach($path in @($temp,$root,$candidate,$installed)) {
        if (((Get-Item -LiteralPath $path -Force).Attributes -band
            [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'stage4_fixture_reparse_forbidden'
        }
    }
    if (-not (& $IsFakeRunning)) { throw 'stage4_fixture_fake_service_not_running' }
    $names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe',
        'gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
    $old=@{}; $new=@{}
    $tag=[Guid]::NewGuid().ToString('N')
    $staged=@{}; $backups=@{}
    foreach($name in $names) {
        $live=Join-Path $installed $name
        $fresh=Join-Path $candidate $name
        foreach($path in @($live,$fresh)) {
            $entry=Get-Item -LiteralPath $path -Force -ErrorAction Stop
            if ($entry.PSIsContainer -or (($entry.Attributes -band
                [IO.FileAttributes]::ReparsePoint) -ne 0)) {
                throw "stage4_fixture_untrusted_file:$name"
            }
        }
        $old[$name]=@{
            hash=(Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash
            sddl=(Get-Acl -LiteralPath $live).Sddl
        }
        $new[$name]=(Get-FileHash -LiteralPath $fresh -Algorithm SHA256).Hash
        if ($old[$name].hash -eq $new[$name]) { throw 'stage4_fixture_no_change' }
        $staged[$name]=Join-Path $installed ('.stage4-'+$tag+'.new.'+$name)
        $backups[$name]=Join-Path $installed ('.stage4-'+$tag+'.old.'+$name)
    }
    try {
        foreach($name in $names) {
            Copy-Item -LiteralPath (Join-Path $candidate $name) -Destination $staged[$name]
            if ((Get-FileHash -LiteralPath $staged[$name] -Algorithm SHA256).Hash -ne $new[$name]) {
                throw 'stage4_fixture_stage_hash_mismatch'
            }
        }
        & $StopFakeService
        if (-not (& $IsFakeStopped)) { throw 'stage4_fixture_stop_not_confirmed' }
        $i=0
        foreach($name in $names) {
            Move-Item -LiteralPath (Join-Path $installed $name) -Destination $backups[$name]
            Move-Item -LiteralPath $staged[$name] -Destination (Join-Path $installed $name)
            $i++
            if ($FailAfterFile -eq $i) { throw 'stage4_fixture_injected_partial_swap' }
        }
        foreach($name in $names) {
            if ((Get-FileHash -LiteralPath (Join-Path $installed $name) -Algorithm SHA256).Hash -ne $new[$name]) {
                throw 'stage4_fixture_new_hash_mismatch'
            }
        }
        & $StartFakeService
        if (-not (& $IsFakeRunning) -or -not (& $CheckFakeHealth)) {
            throw 'stage4_fixture_post_restart_health_failed'
        }
        return [pscustomobject]@{
            kind='STAGE4_TEMPORARY_TRANSACTION_SIMULATOR'
            fixtureOnly=$true
            newFourHashesVerified=$true
            originalsPreservedInSameDirectory=$true
            actualServiceRollbackTested=$false
            installationAuthorized=$false
            realPC1Modified=$false
        }
    } catch {
        $reason=$_.Exception.Message
        try {
            if (-not (& $IsFakeStopped)) {
                & $StopFakeService
                if (-not (& $IsFakeStopped)) { throw 'rollback_stop_unverified' }
            }
            foreach($name in $names) {
                $live=Join-Path $installed $name
                if (Test-Path -LiteralPath $backups[$name]) {
                    if (Test-Path -LiteralPath $live) {
                        $failed=Join-Path $installed ('.stage4-'+$tag+'.failed.'+$name)
                        Move-Item -LiteralPath $live -Destination $failed
                    }
                    Move-Item -LiteralPath $backups[$name] -Destination $live
                }
                if ((Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash -ne $old[$name].hash -or
                    (Get-Acl -LiteralPath $live).Sddl -cne $old[$name].sddl) {
                    throw "rollback_original_hash_or_acl_wrong:$name"
                }
            }
            & $StartFakeService
            if (-not (& $IsFakeRunning)) { throw 'rollback_service_restart_unverified' }
        } catch {
            throw ('stage4_fixture_ROLLBACK_FAILED:'+ $reason + ':' + $_.Exception.Message)
        }
        throw ('stage4_fixture_rollback_verified:'+ $reason)
    }
}
