#Requires -Version 5.1
# Build a protected EXPLICIT snapshot of an inherited Windows ACL for scratch use.
# It does NOT reproduce the original parent/child inheritance relationship.
Set-StrictMode -Version Latest

function New-Stage4ScratchAclSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [System.Security.AccessControl.FileSystemSecurity]$OriginalAcl,
        [switch]$Directory
    )
    $snapshot=if($Directory) {
        [System.Security.AccessControl.DirectorySecurity]::new()
    } else {
        [System.Security.AccessControl.FileSecurity]::new()
    }
    # Clone IN MEMORY; never mutate the security object of the live source.
    $snapshot.SetSecurityDescriptorSddlForm($OriginalAcl.Sddl)
    # On a different parent, inherited ACEs cannot retain their original ID
    # provenance. Convert *all* original effective ACEs to protected explicit
    # equivalents rather than accepting Downloads' unrelated inherited ACEs.
    $snapshot.SetAccessRuleProtection($true,$true)
    if (-not $snapshot.AreAccessRulesProtected) {
        throw 'stage4_scratch_acl_not_protected'
    }
    return $snapshot
}

function Assert-Stage4ScratchAclSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [System.Security.AccessControl.FileSystemSecurity]$Expected,
        [Parameter(Mandatory=$true)]
        [System.Security.AccessControl.FileSystemSecurity]$Observed,
        [Parameter(Mandatory=$true)][string]$Label
    )
    if (-not $Expected.AreAccessRulesProtected -or
        -not $Observed.AreAccessRulesProtected -or
        $Expected.Sddl -cne $Observed.Sddl) {
        throw "stage4_scratch_acl_snapshot_mismatch:$Label"
    }
    return $true
}
