#Requires -Version 5.1
# Shared four-file swap engine. Direct invocation is limited to a fresh TEMP fixture.
# The physical wrapper can call it only with an explicit scoped maintenance token.
Set-StrictMode -Version Latest

# Mandatory before ANY service stop: the precise six read-only checks, all PASS.
# Keep the policy here so Windows CI can execute the EXACT gate used by PC1.
function Assert-Stage4MaintenanceReadiness {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)]$Readiness)
    $expected=@(
        'nonoverlapping-real-folders',
        'new-package-complete-signed-pinned',
        'old-backup-hashes-signatures-acls',
        'machine-context-publisher-chain',
        'known-service-process-topology',
        'expected-gpu-uuid'
    )
    if ($null -eq $Readiness -or
        $Readiness.kind -cne 'STAGE4_PC1_PRIVATE_INSTALL_READINESS_READONLY' -or
        $Readiness.localPreflightPassed -isnot [bool] -or
        $Readiness.localPreflightPassed -ne $true -or
        $Readiness.installAuthorized -isnot [bool] -or
        $Readiness.installAuthorized -ne $false) {
        throw 'stage4_maintenance_all_six_readiness_checks_required'
    }
    $checks=@($Readiness.checks)
    if ($checks.Count -ne $expected.Count) {
        throw 'stage4_maintenance_all_six_readiness_checks_required'
    }
    $seen=@{}
    foreach($check in $checks) {
        if ($null -eq $check -or
            $check.name -cnotin $expected -or
            $seen.ContainsKey([string]$check.name) -or
            $check.passed -isnot [bool] -or
            $check.passed -ne $true) {
            throw 'stage4_maintenance_all_six_readiness_checks_required'
        }
        $seen[[string]$check.name]=$true
    }
    return $true
}

# Pure portion of the post-start process/identity check, exercised against
# negative Windows fixtures. The real wrapper also verifies LocalSystem,
# Session 0, Authenticode and a heartbeat newer than process creation.
function Test-Stage4NewProcessProof {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][DateTime]$ServiceStartUtc,
        [Parameter(Mandatory=$true)][DateTime]$ProcessCreationUtc,
        [Parameter(Mandatory=$true)][int]$InitialProcessId,
        [Parameter(Mandatory=$true)][int]$FinalProcessId,
        [Parameter(Mandatory=$true)][string]$InitialFileHash,
        [Parameter(Mandatory=$true)][string]$FinalFileHash,
        [Parameter(Mandatory=$true)][string]$OldPinnedHash,
        [Parameter(Mandatory=$true)][string]$NewPinnedHash
    )
    if ($ServiceStartUtc -eq [DateTime]::MinValue -or
        $InitialProcessId -le 0 -or $FinalProcessId -ne $InitialProcessId -or
        $ProcessCreationUtc -lt $ServiceStartUtc.AddSeconds(-5) -or
        $ProcessCreationUtc -gt [DateTime]::UtcNow.AddSeconds(5) -or
        $InitialFileHash -cnotmatch '^[0-9A-Fa-f]{64}
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$TargetDirectory,
        [Parameter(Mandatory=$true)][string]$CandidateDirectory,
        [Parameter(Mandatory=$true)][hashtable]$OldHashes,
        [Parameter(Mandatory=$true)][hashtable]$NewHashes,
        [Parameter(Mandatory=$true)][hashtable]$OldSddl,
        [Parameter(Mandatory=$true)][scriptblock]$StopControlledService,
        [Parameter(Mandatory=$true)][scriptblock]$StartControlledService,
        [Parameter(Mandatory=$true)][scriptblock]$IsControlledServiceRunning,
        [Parameter(Mandatory=$true)][scriptblock]$IsControlledServiceStopped,
        [Parameter(Mandatory=$true)][scriptblock]$ValidateControlledRuntime,
        [string]$MaintenanceToken='',
        [ValidateRange(0,4)][int]$InjectFailureAfter=0,
        # TEMP fixture only: prove cleanup of a partial pre-stop staging failure.
        [ValidateRange(0,4)][int]$InjectStageFailureAfter=0
    )
    $ErrorActionPreference='Stop'
    $names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe',
        'gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
    $target=[IO.Path]::GetFullPath($TargetDirectory).TrimEnd('\')
    $candidate=[IO.Path]::GetFullPath($CandidateDirectory).TrimEnd('\')
    $temp=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
    $fixture=($target.StartsWith($temp+'\GPUbnb-stage4-maintenance-test-',[StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf (Split-Path -Parent $target)) -cmatch '^GPUbnb-stage4-maintenance-test-[a-f0-9]{32}$' -and
        (Split-Path -Leaf $target) -ceq 'installed' -and
        $candidate -ieq (Join-Path (Split-Path -Parent $target) 'candidate'))
    $physical=($target -ieq 'C:\Program Files\GPUbnb' -and
        $InjectFailureAfter -eq 0 -and $InjectStageFailureAfter -eq 0 -and
        $MaintenanceToken -ceq 'STAGE4-PHYSICAL-MAINTENANCE-AUTHORIZED-BY-PREFLIGHT')
    if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess -or
        -not ($fixture -or $physical) -or
        -not (Test-Path -LiteralPath $target -PathType Container) -or
        -not (Test-Path -LiteralPath $candidate -PathType Container)) {
        throw 'stage4_core_rejects_unapproved_install_path'
    }
    foreach($dir in @($target,$candidate)) {
        $node=Get-Item -LiteralPath $dir -Force -ErrorAction Stop
        while($null -ne $node) {
            if (($node.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'stage4_core_symlink_directory_forbidden'
            }
            $node=$node.Parent
        }
    }
    if (-not (& $IsControlledServiceRunning)) {
        throw 'stage4_core_service_not_running'
    }
    $tag=[Guid]::NewGuid().ToString('N')
    $staged=@{}
    $oldPaths=@{}
    $failedPaths=@{}
    $originalAcl=@{}
    $serviceStopAttempted=$false
    $newInstalled=$false
    foreach($name in $names) {
        if (-not $OldHashes.ContainsKey($name) -or -not $NewHashes.ContainsKey($name) -or
            -not $OldSddl.ContainsKey($name)) { throw 'stage4_core_missing_hash_or_acl_pin' }
        $oldFile=Join-Path $target $name
        $newFile=Join-Path $candidate $name
        foreach($path in @($oldFile,$newFile)) {
            $entry=Get-Item -LiteralPath $path -Force -ErrorAction Stop
            if ($entry.PSIsContainer -or
                ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'stage4_core_file_symlink_forbidden'
            }
        }
        $originalAcl[$name]=Get-Acl -LiteralPath $oldFile
        if ((Get-FileHash -LiteralPath $oldFile -Algorithm SHA256).Hash -ine $OldHashes[$name] -or
            $originalAcl[$name].Sddl -cne $OldSddl[$name] -or
            (Get-FileHash -LiteralPath $newFile -Algorithm SHA256).Hash -ine $NewHashes[$name]) {
            throw "stage4_core_input_drift:$name"
        }
        $staged[$name]=Join-Path $target ('.stage4-'+$tag+'.new.'+$name)
        $oldPaths[$name]=Join-Path $target ('.stage4-'+$tag+'.old.'+$name)
        $failedPaths[$name]=Join-Path $target ('.stage4-'+$tag+'.failed.'+$name)
    }
    try {
        $stagedCount=0
        foreach($name in $names) {
            Copy-Item -LiteralPath (Join-Path $candidate $name) -Destination $staged[$name] -ErrorAction Stop
            # Copy into the SAME NTFS parent. Inherited ACL provenance is
            # preserved naturally. Do not use Set-Acl or File.Replace: Windows
            # can add duplicate explicit ACEs to the inherited DACL.
            if ((Get-FileHash -LiteralPath $staged[$name] -Algorithm SHA256).Hash -ine $NewHashes[$name] -or
                (Get-Acl -LiteralPath $staged[$name]).Sddl -cne $OldSddl[$name]) {
                throw "stage4_core_pre_stop_stage_bytes_or_acl_mismatch:$name"
            }
            $stagedCount++
            if ($InjectStageFailureAfter -eq $stagedCount) {
                throw 'stage4_core_injected_pre_stop_staging_failure'
            }
        }
        $serviceStopAttempted=$true
        & $StopControlledService
        if (-not (& $IsControlledServiceStopped)) {
            throw 'stage4_core_stop_not_confirmed'
        }
        $i=0
        foreach($name in $names) {
            # Same-parent renames keep each file's native NTFS security descriptor.
            # Staged ACL was already verified against the pinned ORIGINAL SDDL.
            Move-Item -LiteralPath (Join-Path $target $name) -Destination $oldPaths[$name] -ErrorAction Stop
            Move-Item -LiteralPath $staged[$name] -Destination (Join-Path $target $name) -ErrorAction Stop
            if ((Get-FileHash -LiteralPath $oldPaths[$name] -Algorithm SHA256).Hash -ine $OldHashes[$name] -or
                (Get-Acl -LiteralPath $oldPaths[$name]).Sddl -cne $OldSddl[$name]) {
                throw "stage4_core_backup_original_not_pinned:$name"
            }
            $i++
            if ($InjectFailureAfter -eq $i) { throw 'stage4_core_injected_partial_swap' }
        }
        foreach($name in $names) {
            $path=Join-Path $target $name
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $NewHashes[$name]) {
                throw "stage4_core_installed_hash_mismatch:$name"
            }
            $observedSddl=(Get-Acl -LiteralPath $path).Sddl
            if ($observedSddl -cne $OldSddl[$name]) {
                throw "stage4_core_installed_acl_mismatch:$name"
            }
        }
        & $StartControlledService
        if (-not (& $IsControlledServiceRunning) -or
            -not (& $ValidateControlledRuntime)) {
            throw 'stage4_core_runtime_not_healthy'
        }
        $newInstalled=$true
        return [pscustomobject]@{
            kind='STAGE4_PRIVATE_FOUR_FILE_TRANSACTION'
            fourInstalledHashesAndAclsVerified=$true
            originalBackupsPreservedInSameDirectory=4
            rollbackActuallyPerformed=$false
            isTemporaryFixture=$fixture
            actualPC1Touched=$physical
            publicBookabilityEnabled=$false
            quarantineModified=$false
            backupFiles=@($names | ForEach-Object { $oldPaths[$_] })
        }
    } catch {
        $reason=$_.Exception.Message
        # If staging fails, the service and originals are untouched, but copies
        # may have been created in the installation directory. Remove only our
        # GUID-named staged paths; never stop a healthy production service.
        if (-not $serviceStopAttempted) {
            $cleanupErrors=@()
            foreach ($name in $names) {
                $path=$staged[$name]
                if (Test-Path -LiteralPath $path) {
                    try {
                        $entry=Get-Item -LiteralPath $path -Force -ErrorAction Stop
                        if ($entry.PSIsContainer -or
                            ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                            throw 'stage4_core_unexpected_staged_path'
                        }
                        Remove-Item -LiteralPath $path -Force -ErrorAction Stop
                    } catch { $cleanupErrors+=($_.Exception.Message) }
                }
            }
            if ($cleanupErrors.Count -gt 0) {
                throw ('stage4_core_pre_stop_cleanup_failed:'+$reason+':'+($cleanupErrors -join ';'))
            }
            throw ('stage4_core_pre_stop_cleanup_verified:'+$reason)
        }
        $rollbackError=$null
        try {
            if (-not (& $IsControlledServiceStopped)) {
                & $StopControlledService
                if (-not (& $IsControlledServiceStopped)) {
                    throw 'stage4_core_rollback_stop_not_confirmed'
                }
            }
            foreach($name in $names) {
                $live=Join-Path $target $name
                if (Test-Path -LiteralPath $oldPaths[$name]) {
                    if (Test-Path -LiteralPath $live) {
                        Move-Item -LiteralPath $live -Destination $failedPaths[$name] -ErrorAction Stop
                    }
                    Move-Item -LiteralPath $oldPaths[$name] -Destination $live -ErrorAction Stop
                }
                if ((Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash -ine $OldHashes[$name] -or
                    (Get-Acl -LiteralPath $live).Sddl -cne $OldSddl[$name]) {
                    throw "stage4_core_rollback_old_file_or_acl_wrong:$name"
                }
            }
            & $StartControlledService
            if (-not (& $IsControlledServiceRunning)) {
                throw 'stage4_core_rollback_restart_not_confirmed'
            }
            # File hash/ACL restoration and a Windows Running status are not
            # evidence that the restored Agent can actually run health checks.
            # Never report ROLLBACK_VERIFIED on an unhealthy old process.
            if (-not (& $ValidateControlledRuntime)) {
                throw 'stage4_core_rollback_runtime_unhealthy'
            }
        } catch { $rollbackError=$_.Exception.Message }
        if ($rollbackError) {
            throw ('stage4_core_ROLLBACK_FAILED:'+$reason+':'+$rollbackError)
        }
        throw ('stage4_core_ROLLBACK_VERIFIED:'+$reason)
    }
}
 -or
        $FinalFileHash -ine $InitialFileHash -or
        ($InitialFileHash -ine $OldPinnedHash -and $InitialFileHash -ine $NewPinnedHash)) {
        return $false
    }
    return $true
}

function Invoke-Stage4FourFileTransactionCore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$TargetDirectory,
        [Parameter(Mandatory=$true)][string]$CandidateDirectory,
        [Parameter(Mandatory=$true)][hashtable]$OldHashes,
        [Parameter(Mandatory=$true)][hashtable]$NewHashes,
        [Parameter(Mandatory=$true)][hashtable]$OldSddl,
        [Parameter(Mandatory=$true)][scriptblock]$StopControlledService,
        [Parameter(Mandatory=$true)][scriptblock]$StartControlledService,
        [Parameter(Mandatory=$true)][scriptblock]$IsControlledServiceRunning,
        [Parameter(Mandatory=$true)][scriptblock]$IsControlledServiceStopped,
        [Parameter(Mandatory=$true)][scriptblock]$ValidateControlledRuntime,
        [string]$MaintenanceToken='',
        [ValidateRange(0,4)][int]$InjectFailureAfter=0,
        # TEMP fixture only: prove cleanup of a partial pre-stop staging failure.
        [ValidateRange(0,4)][int]$InjectStageFailureAfter=0
    )
    $ErrorActionPreference='Stop'
    $names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe',
        'gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
    $target=[IO.Path]::GetFullPath($TargetDirectory).TrimEnd('\')
    $candidate=[IO.Path]::GetFullPath($CandidateDirectory).TrimEnd('\')
    $temp=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
    $fixture=($target.StartsWith($temp+'\GPUbnb-stage4-maintenance-test-',[StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf (Split-Path -Parent $target)) -cmatch '^GPUbnb-stage4-maintenance-test-[a-f0-9]{32}$' -and
        (Split-Path -Leaf $target) -ceq 'installed' -and
        $candidate -ieq (Join-Path (Split-Path -Parent $target) 'candidate'))
    $physical=($target -ieq 'C:\Program Files\GPUbnb' -and
        $InjectFailureAfter -eq 0 -and $InjectStageFailureAfter -eq 0 -and
        $MaintenanceToken -ceq 'STAGE4-PHYSICAL-MAINTENANCE-AUTHORIZED-BY-PREFLIGHT')
    if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess -or
        -not ($fixture -or $physical) -or
        -not (Test-Path -LiteralPath $target -PathType Container) -or
        -not (Test-Path -LiteralPath $candidate -PathType Container)) {
        throw 'stage4_core_rejects_unapproved_install_path'
    }
    foreach($dir in @($target,$candidate)) {
        $node=Get-Item -LiteralPath $dir -Force -ErrorAction Stop
        while($null -ne $node) {
            if (($node.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'stage4_core_symlink_directory_forbidden'
            }
            $node=$node.Parent
        }
    }
    if (-not (& $IsControlledServiceRunning)) {
        throw 'stage4_core_service_not_running'
    }
    $tag=[Guid]::NewGuid().ToString('N')
    $staged=@{}
    $oldPaths=@{}
    $failedPaths=@{}
    $originalAcl=@{}
    $serviceStopAttempted=$false
    $newInstalled=$false
    foreach($name in $names) {
        if (-not $OldHashes.ContainsKey($name) -or -not $NewHashes.ContainsKey($name) -or
            -not $OldSddl.ContainsKey($name)) { throw 'stage4_core_missing_hash_or_acl_pin' }
        $oldFile=Join-Path $target $name
        $newFile=Join-Path $candidate $name
        foreach($path in @($oldFile,$newFile)) {
            $entry=Get-Item -LiteralPath $path -Force -ErrorAction Stop
            if ($entry.PSIsContainer -or
                ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'stage4_core_file_symlink_forbidden'
            }
        }
        $originalAcl[$name]=Get-Acl -LiteralPath $oldFile
        if ((Get-FileHash -LiteralPath $oldFile -Algorithm SHA256).Hash -ine $OldHashes[$name] -or
            $originalAcl[$name].Sddl -cne $OldSddl[$name] -or
            (Get-FileHash -LiteralPath $newFile -Algorithm SHA256).Hash -ine $NewHashes[$name]) {
            throw "stage4_core_input_drift:$name"
        }
        $staged[$name]=Join-Path $target ('.stage4-'+$tag+'.new.'+$name)
        $oldPaths[$name]=Join-Path $target ('.stage4-'+$tag+'.old.'+$name)
        $failedPaths[$name]=Join-Path $target ('.stage4-'+$tag+'.failed.'+$name)
    }
    try {
        $stagedCount=0
        foreach($name in $names) {
            Copy-Item -LiteralPath (Join-Path $candidate $name) -Destination $staged[$name] -ErrorAction Stop
            # Copy into the SAME NTFS parent. Inherited ACL provenance is
            # preserved naturally. Do not use Set-Acl or File.Replace: Windows
            # can add duplicate explicit ACEs to the inherited DACL.
            if ((Get-FileHash -LiteralPath $staged[$name] -Algorithm SHA256).Hash -ine $NewHashes[$name] -or
                (Get-Acl -LiteralPath $staged[$name]).Sddl -cne $OldSddl[$name]) {
                throw "stage4_core_pre_stop_stage_bytes_or_acl_mismatch:$name"
            }
            $stagedCount++
            if ($InjectStageFailureAfter -eq $stagedCount) {
                throw 'stage4_core_injected_pre_stop_staging_failure'
            }
        }
        $serviceStopAttempted=$true
        & $StopControlledService
        if (-not (& $IsControlledServiceStopped)) {
            throw 'stage4_core_stop_not_confirmed'
        }
        $i=0
        foreach($name in $names) {
            # Same-parent renames keep each file's native NTFS security descriptor.
            # Staged ACL was already verified against the pinned ORIGINAL SDDL.
            Move-Item -LiteralPath (Join-Path $target $name) -Destination $oldPaths[$name] -ErrorAction Stop
            Move-Item -LiteralPath $staged[$name] -Destination (Join-Path $target $name) -ErrorAction Stop
            if ((Get-FileHash -LiteralPath $oldPaths[$name] -Algorithm SHA256).Hash -ine $OldHashes[$name] -or
                (Get-Acl -LiteralPath $oldPaths[$name]).Sddl -cne $OldSddl[$name]) {
                throw "stage4_core_backup_original_not_pinned:$name"
            }
            $i++
            if ($InjectFailureAfter -eq $i) { throw 'stage4_core_injected_partial_swap' }
        }
        foreach($name in $names) {
            $path=Join-Path $target $name
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $NewHashes[$name]) {
                throw "stage4_core_installed_hash_mismatch:$name"
            }
            $observedSddl=(Get-Acl -LiteralPath $path).Sddl
            if ($observedSddl -cne $OldSddl[$name]) {
                throw "stage4_core_installed_acl_mismatch:$name"
            }
        }
        & $StartControlledService
        if (-not (& $IsControlledServiceRunning) -or
            -not (& $ValidateControlledRuntime)) {
            throw 'stage4_core_runtime_not_healthy'
        }
        $newInstalled=$true
        return [pscustomobject]@{
            kind='STAGE4_PRIVATE_FOUR_FILE_TRANSACTION'
            fourInstalledHashesAndAclsVerified=$true
            originalBackupsPreservedInSameDirectory=4
            rollbackActuallyPerformed=$false
            isTemporaryFixture=$fixture
            actualPC1Touched=$physical
            publicBookabilityEnabled=$false
            quarantineModified=$false
            backupFiles=@($names | ForEach-Object { $oldPaths[$_] })
        }
    } catch {
        $reason=$_.Exception.Message
        # If staging fails, the service and originals are untouched, but copies
        # may have been created in the installation directory. Remove only our
        # GUID-named staged paths; never stop a healthy production service.
        if (-not $serviceStopAttempted) {
            $cleanupErrors=@()
            foreach ($name in $names) {
                $path=$staged[$name]
                if (Test-Path -LiteralPath $path) {
                    try {
                        $entry=Get-Item -LiteralPath $path -Force -ErrorAction Stop
                        if ($entry.PSIsContainer -or
                            ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                            throw 'stage4_core_unexpected_staged_path'
                        }
                        Remove-Item -LiteralPath $path -Force -ErrorAction Stop
                    } catch { $cleanupErrors+=($_.Exception.Message) }
                }
            }
            if ($cleanupErrors.Count -gt 0) {
                throw ('stage4_core_pre_stop_cleanup_failed:'+$reason+':'+($cleanupErrors -join ';'))
            }
            throw ('stage4_core_pre_stop_cleanup_verified:'+$reason)
        }
        $rollbackError=$null
        try {
            if (-not (& $IsControlledServiceStopped)) {
                & $StopControlledService
                if (-not (& $IsControlledServiceStopped)) {
                    throw 'stage4_core_rollback_stop_not_confirmed'
                }
            }
            foreach($name in $names) {
                $live=Join-Path $target $name
                if (Test-Path -LiteralPath $oldPaths[$name]) {
                    if (Test-Path -LiteralPath $live) {
                        Move-Item -LiteralPath $live -Destination $failedPaths[$name] -ErrorAction Stop
                    }
                    Move-Item -LiteralPath $oldPaths[$name] -Destination $live -ErrorAction Stop
                }
                if ((Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash -ine $OldHashes[$name] -or
                    (Get-Acl -LiteralPath $live).Sddl -cne $OldSddl[$name]) {
                    throw "stage4_core_rollback_old_file_or_acl_wrong:$name"
                }
            }
            & $StartControlledService
            if (-not (& $IsControlledServiceRunning)) {
                throw 'stage4_core_rollback_restart_not_confirmed'
            }
            # File hash/ACL restoration and a Windows Running status are not
            # evidence that the restored Agent can actually run health checks.
            # Never report ROLLBACK_VERIFIED on an unhealthy old process.
            if (-not (& $ValidateControlledRuntime)) {
                throw 'stage4_core_rollback_runtime_unhealthy'
            }
        } catch { $rollbackError=$_.Exception.Message }
        if ($rollbackError) {
            throw ('stage4_core_ROLLBACK_FAILED:'+$reason+':'+$rollbackError)
        }
        throw ('stage4_core_ROLLBACK_VERIFIED:'+$reason)
    }
}
