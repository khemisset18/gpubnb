#Requires -Version 5.1
Set-StrictMode -Version Latest

if ($null -eq ('GpubnbStage4PathNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;

public static class GpubnbStage4PathNative {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="GetLongPathNameW")]
    public static extern uint GetLongPathName(string shortPath, StringBuilder longPath, uint capacity);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="GetShortPathNameW")]
    public static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint capacity);
}
'@
}

function Get-Stage4CanonicalWindowsPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [switch]$AllowMissingLeaf
    )
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.IndexOf([char]0) -ge 0 -or
        $Path.StartsWith('\\?\',[StringComparison]::Ordinal) -or
        $Path.StartsWith('\\.\',[StringComparison]::Ordinal) -or
        $Path.StartsWith('\\',[StringComparison]::Ordinal)) {
        throw 'stage4_path_namespace_not_allowed'
    }
    $slashPath=$Path.Replace('/','\')
    if ($slashPath -cnotmatch '^[a-zA-Z]:\\') { throw 'stage4_path_absolute_drive_required' }
    try { $full=[IO.Path]::GetFullPath($slashPath) }
    catch { throw 'stage4_path_invalid' }
    $driveRoot=[IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $driveRoot.Length) { $full=$full.TrimEnd('\') }

    if (-not (Test-Path -LiteralPath $full)) {
        if (-not $AllowMissingLeaf) { throw 'stage4_path_missing' }
        $leaf=[IO.Path]::GetFileName($full)
        $parent=[IO.Path]::GetDirectoryName($full)
        if ([string]::IsNullOrWhiteSpace($leaf) -or $leaf -in @('.','..') -or
            -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw 'stage4_path_parent_missing'
        }
        $canonicalParent=Get-Stage4CanonicalWindowsPath -Path $parent
        return Join-Path $canonicalParent $leaf
    }

    $node=Get-Item -LiteralPath $full -Force -ErrorAction Stop
    while ($null -ne $node) {
        if (($node.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'stage4_path_reparse_forbidden'
        }
        $node=if ($node -is [IO.DirectoryInfo]) { $node.Parent } else { $node.Directory }
    }
    $buffer=[Text.StringBuilder]::new(32768)
    $length=[GpubnbStage4PathNative]::GetLongPathName($full,$buffer,[uint32]$buffer.Capacity)
    if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'stage4_path_canonicalization_failed' }
    $expanded=$buffer.ToString()
    if ($expanded.StartsWith('\\?\UNC\',[StringComparison]::OrdinalIgnoreCase) -or
        $expanded.StartsWith('\\?\',[StringComparison]::Ordinal)) {
        throw 'stage4_path_extended_namespace_returned'
    }
    $canonical=[IO.Path]::GetFullPath($expanded)
    $canonicalRoot=[IO.Path]::GetPathRoot($canonical)
    if($canonical.Length -gt $canonicalRoot.Length){$canonical=$canonical.TrimEnd('\')}
    return $canonical
}

function Assert-Stage4InstallPathsDisjoint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$CandidateDirectory,
        [Parameter(Mandatory=$true)][string]$BackupDirectory,
        [Parameter(Mandatory=$true)][string]$InstalledDirectory
    )
    $candidate=Get-Stage4CanonicalWindowsPath -Path $CandidateDirectory -AllowMissingLeaf
    $backup=Get-Stage4CanonicalWindowsPath -Path $BackupDirectory -AllowMissingLeaf
    $installed=Get-Stage4CanonicalWindowsPath -Path $InstalledDirectory -AllowMissingLeaf
    $paths=@($candidate,$backup,$installed)
    for($i=0;$i -lt $paths.Count;$i++) {
        for($j=$i+1;$j -lt $paths.Count;$j++) {
            $left=$paths[$i];$right=$paths[$j]
            if ($left -ieq $right -or
                $left.StartsWith($right+'\',[StringComparison]::OrdinalIgnoreCase) -or
                $right.StartsWith($left+'\',[StringComparison]::OrdinalIgnoreCase)) {
                throw 'stage4_install_readiness_paths_overlap'
            }
        }
    }
    return [pscustomobject]@{candidate=$candidate;backup=$backup;installed=$installed}
}
