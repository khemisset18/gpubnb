#Requires -Version 5.1
# Pure path policy for a scratch-only Stage 4 backup reconstruction.
# Does NOT grant permission to install, stop services, alter trust, or clear quarantine.
Set-StrictMode -Version Latest

function Assert-Stage4OfflineRollbackPaths {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$CandidateDirectory,
        [Parameter(Mandatory=$true)][string]$BackupDirectory,
        [Parameter(Mandatory=$true)][string]$OutputDirectory,
        [Parameter(Mandatory=$true)][string]$DownloadsDirectory
    )
    $candidate=[IO.Path]::GetFullPath($CandidateDirectory).TrimEnd('\\')
    $backup=[IO.Path]::GetFullPath($BackupDirectory).TrimEnd('\\')
    $output=[IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\\')
    $downloads=[IO.Path]::GetFullPath($DownloadsDirectory).TrimEnd('\\')
    $installed='C:\\Program Files\\GPUbnb'
    $paths=@($candidate,$backup,$output)
    if ((Test-Path -LiteralPath $output) -or
        -not (Test-Path -LiteralPath $downloads -PathType Container) -or
        -not $output.StartsWith($downloads+'\\',[StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Parent $output) -ine $downloads -or
        (Split-Path -Leaf $output) -cnotmatch '^GPUbnb-Stage4-rollback-rehearsal-[A-Za-z0-9_-]{4,80}$') {
        throw 'stage4_offline_scratch_must_be_new_direct_downloads_child'
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Container) -or
        -not (Test-Path -LiteralPath $backup -PathType Container)) {
        throw 'stage4_offline_missing_source_directories'
    }
    for($i=0;$i -lt $paths.Count;$i++){
        if ($paths[$i] -ieq $installed -or
            $paths[$i].StartsWith($installed+'\\',[StringComparison]::OrdinalIgnoreCase) -or
            $installed.StartsWith($paths[$i]+'\\',[StringComparison]::OrdinalIgnoreCase)) {
            throw 'stage4_offline_installed_path_forbidden'
        }
        for($j=$i+1;$j -lt $paths.Count;$j++){
            if ($paths[$i] -ieq $paths[$j] -or
                $paths[$i].StartsWith($paths[$j]+'\\',[StringComparison]::OrdinalIgnoreCase) -or
                $paths[$j].StartsWith($paths[$i]+'\\',[StringComparison]::OrdinalIgnoreCase)) {
                throw 'stage4_offline_paths_overlap'
            }
        }
    }
    foreach ($dir in @($candidate,$backup,$downloads)) {
        $node=Get-Item -LiteralPath $dir -Force -ErrorAction Stop
        while ($null -ne $node) {
            if (($node.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'stage4_offline_reparse_directory_forbidden'
            }
            $node=$node.Parent
        }
    }
    return $true
}
