#Requires -Version 5.1
# Offline policy tests. All fixture writes are under this process's temporary folder.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$scripts=Split-Path -Parent $PSScriptRoot
$policyPath=Join-Path $scripts 'stage4-private-offline-rollback-policy.ps1'
$entry=Join-Path $scripts 'stage4-private-offline-rollback-drill.ps1'
foreach ($path in @($policyPath,$entry)) {
    $tokens=$null
    $errors=$null
    [void][Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
    if ($errors.Count -gt 0) { throw "offline_rollback_parser_error:$($errors[0].Message)" }
}
$source=Get-Content -LiteralPath $entry -Raw
if ($source -match '\b(?:Stop-Service|Start-Service|Restart-Service|Stop-Process|Invoke-WebRequest|Invoke-RestMethod|Import-Certificate|Remove-Item|Move-Item|Set-Service|Set-ItemProperty|New-Service|sc\.exe)\b') {
    throw 'offline_rollback_forbidden_service_network_or_cleanup_operation'
}
foreach ($flag in @('installationAuthorized','installationPerformed','realServiceRollbackTested',
    'backendReleaseIndependentlyAttested','physicalCleanupProven','quarantineModified',
    'publicBookabilityEnabled')) {
    if ($source -cnotmatch "(?m)^\s*$flag=\`$false\s*$") {
        throw "offline_rollback_must_fail_closed:$flag"
    }
}
# No ACL mutation in the operational scratch drill. Inherited NTFS ACLs are
# parent-specific; this experiment tests file bytes, not ACL reconstruction.
$copyLines=@($source -split '\r?\n' | Where-Object { $_ -match '^\s*Copy-Item\b' })
if ($copyLines.Count -ne 2 -or
    @($copyLines | Where-Object { $_ -notmatch '-Destination \$target' }).Count -gt 0 -or
    $source -match '\b(?:Set-Acl|icacls|SetSecurityDescriptorSddlForm|SetAccessRuleProtection)\b') {
    throw 'offline_rollback_dangerous_mutation_or_wrong_copy_target'
}
foreach($flag in @('scratchAclReconstructionVerified','originalParentInheritanceReproduced',
    'realServiceFileAclsRestored')) {
    if ($source -cnotmatch "(?m)^\s*$flag=\`$false\s*$") {
        throw "offline_rollback_must_not_claim_acl_reconstruction:$flag"
    }
}
foreach($flag in @('scratchFourFileHashesAndSignaturesVerified','liveFourFileAclsMatchPinnedBackup',
    'liveDirectoryAclMatchesPinnedBackup')) {
    if ($source -cnotmatch "(?m)^\s*$flag=\`$true\s*$") {
        throw "offline_rollback_missing_evidence_flag:$flag"
    }
}
. $policyPath
$root=Join-Path $env:TEMP ('gpubnb-offline-rollback-tests-'+[Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $root)
try {
    $downloads=Join-Path $root 'Downloads'
    $candidate=Join-Path $root 'candidate'
    $backup=Join-Path $root 'backup'
    foreach($dir in @($downloads,$candidate,$backup)){
        [void](New-Item -ItemType Directory -Path $dir)
    }
    $valid=Join-Path $downloads 'GPUbnb-Stage4-rollback-rehearsal-TEST1234'
    $script:baseParams=@{CandidateDirectory=$candidate;BackupDirectory=$backup;OutputDirectory=$valid;DownloadsDirectory=$downloads}
    if (-not (Assert-Stage4OfflineRollbackPaths @baseParams)) { throw 'offline_rollback_valid_scratch_rejected' }
    Write-Host 'PASS new scratch child'
    function Reject([string]$label,[hashtable]$replacement){
        $changed=@{} + $script:baseParams
        foreach($kv in $replacement.GetEnumerator()){$changed[$kv.Key]=$kv.Value}
        $failed=$false
        try{[void](Assert-Stage4OfflineRollbackPaths @changed)}catch{$failed=$true}
        if(-not $failed){throw "offline_rollback_missing_rejection:$label"}
        Write-Host "PASS reject $label"
    }
    Reject 'output equals backup' @{OutputDirectory=$backup}
    Reject 'output outside Downloads' @{OutputDirectory=(Join-Path $root 'GPUbnb-Stage4-rollback-rehearsal-TEST1234')}
    Reject 'output at Downloads root' @{OutputDirectory=$downloads}
    Reject 'wrong output prefix' @{OutputDirectory=(Join-Path $downloads 'potential-install')}
    Reject 'nested output' @{OutputDirectory=(Join-Path $downloads 'other\GPUbnb-Stage4-rollback-rehearsal-TEST1234')}
    Reject 'candidate nested in backup' @{CandidateDirectory=$backup}
    Reject 'installed folder as candidate' @{CandidateDirectory='C:\Program Files\GPUbnb'}
    [void](New-Item -ItemType Directory -Path $valid)
    Reject 'output already exists' @{}
    # Reconstruct a fake four-file candidate-to-backup overlay in a fresh scratch
    # directory; verify hash differences and exact old bytes after replacement.
    # No test of real service or ACL restoration is implied.
    $scratch=Join-Path $root 'scratch'
    [void](New-Item -ItemType Directory -Path $scratch)
    $files=@('gpubnb-agent.exe','gpubnb-windows-stream.exe',
        'gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
    foreach($name in $files) {
        $newFile=Join-Path $candidate $name
        $oldFile=Join-Path $backup $name
        $clone=Join-Path $scratch $name
        [IO.File]::WriteAllText($newFile,("candidate-"+$name))
        [IO.File]::WriteAllText($oldFile,("backup-"+$name))
        $oldHash=(Get-FileHash -LiteralPath $oldFile -Algorithm SHA256).Hash
        Copy-Item -LiteralPath $newFile -Destination $clone
        if ((Get-FileHash -LiteralPath $clone -Algorithm SHA256).Hash -eq $oldHash) {
            throw "offline_rollback_fixture_candidate_same_as_backup:$name"
        }
        Copy-Item -LiteralPath $oldFile -Destination $clone -Force
        if ((Get-FileHash -LiteralPath $clone -Algorithm SHA256).Hash -ne $oldHash) {
            throw "offline_rollback_fixture_overlay_mismatch:$name"
        }
    }
    Write-Host 'PASS four-file scratch overlay restores pinned bytes only'
    # A real Windows parent ACL difference does not invalidate *byte* checks.
    $aclA=Get-Acl -LiteralPath $candidate
    $aclB=Get-Acl -LiteralPath $scratch
    if ($null -eq $aclA -or $null -eq $aclB) {
        throw 'offline_rollback_fixture_acl_inspection_unavailable'
    }
    Write-Host 'PASS scratch ACL is inspected, never transplanted'
    Write-Host 'PASS offline rollback script parse and fail-closed static checks'
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
