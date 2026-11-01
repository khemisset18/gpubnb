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
# Mutation commands must remain visibly targeted at the sandbox variables;
# do not allow new unreviewed Copy-Item/Set-Acl destinations or output paths.
$copyLines=@($source -split '\r?\n' | Where-Object { $_ -match '^\s*Copy-Item\b' })
$aclLines=@($source -split '\r?\n' | Where-Object { $_ -match '^\s*Set-Acl\b' })
if ($copyLines.Count -ne 2 -or @($copyLines | Where-Object { $_ -notmatch '-Destination \$target' }).Count -gt 0 -or
    $aclLines.Count -ne 2 -or @($aclLines | Where-Object { $_ -notmatch '-LiteralPath \$(target|scratch)\b' }).Count -gt 0) {
    throw 'offline_rollback_mutation_targets_changed_requires_review'
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
    Write-Host 'PASS offline rollback script parse and fail-closed static checks'
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
