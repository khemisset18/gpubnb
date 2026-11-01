#Requires -Version 5.1
# Shared four-file swap engine. Direct invocation is limited to a fresh TEMP fixture.
# The physical wrapper can call it only with an explicit scoped maintenance token.
Set-StrictMode -Version Latest

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
        [ValidateRange(0,4)][int]$InjectFailureAfter=0
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
        $InjectFailureAfter -eq 0 -and
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
        foreach($name in $names) {
            Copy-Item -LiteralPath (Join-Path $candidate $name) -Destination $staged[$name] -ErrorAction Stop
            # Same NTFS parent directory as original. Copy original ACL onto
            # stage, then require EXACT original SDDL before any service stop.
            Set-Acl -LiteralPath $staged[$name] -AclObject $originalAcl[$name] -ErrorAction Stop
            if ((Get-Acl -LiteralPath $staged[$name]).Sddl -cne $OldSddl[$name] -or
                (Get-FileHash -LiteralPath $staged[$name] -Algorithm SHA256).Hash -ine $NewHashes[$name]) {
                throw "stage4_core_staging_acl_or_hash_mismatch:$name"
            }
        }
        & $StopControlledService
        if (-not (& $IsControlledServiceStopped)) {
            throw 'stage4_core_stop_not_confirmed'
        }
        $i=0
        foreach($name in $names) {
            Move-Item -LiteralPath (Join-Path $target $name) -Destination $oldPaths[$name] -ErrorAction Stop
            Move-Item -LiteralPath $staged[$name] -Destination (Join-Path $target $name) -ErrorAction Stop
            $i++
            if ($InjectFailureAfter -eq $i) { throw 'stage4_core_injected_partial_swap' }
        }
        foreach($name in $names) {
            $path=Join-Path $target $name
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $NewHashes[$name] -or
                (Get-Acl -LiteralPath $path).Sddl -cne $OldSddl[$name]) {
                throw "stage4_core_installed_not_pinned:$name"
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
        } catch { $rollbackError=$_.Exception.Message }
        if ($rollbackError) {
            throw ('stage4_core_ROLLBACK_FAILED:'+$reason+':'+$rollbackError)
        }
        throw ('stage4_core_ROLLBACK_VERIFIED:'+$reason)
    }
}
