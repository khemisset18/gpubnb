#Requires -Version 5.1
# Synthetic hashes only. No signing, Windows trust changes, installation or execution.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../stage4-package-common.ps1')
function Assert-Rejected([scriptblock]$Action,[string]$Expected){
    try { & $Action } catch {
        if($_.Exception.Message -cne $Expected){throw}
        return
    }
    throw "Expected rejection: $Expected"
}
$mediaHash='ab'*32
$workerHash='cd'*32
$helperHash='ef'*32
$records=@(
    [pscustomobject]@{name='GPUbnbWindowsMedia.dll';sha256=$mediaHash}
    [pscustomobject]@{name='gpubnb-windows-worker.exe';sha256=$workerHash}
    [pscustomobject]@{name='gpubnb-windows-stream.exe';sha256=$helperHash}
)
$identity=[pscustomobject]@{
    agent=[pscustomobject]@{}
    helper=[pscustomobject]@{}
    worker=[pscustomobject]@{}
}
# Legacy all-absent evidence remains on the existing signature-only path.
Assert-Stage4UnsignedBuildChain $identity $records
$identity.worker|Add-Member -NotePropertyName unsignedMediaSha256 -NotePropertyValue $mediaHash
Assert-Rejected {Assert-Stage4UnsignedBuildChain $identity $records} 'stage4_unsigned_build_chain_incomplete'
$identity.helper|Add-Member -NotePropertyName unsignedWorkerSha256 -NotePropertyValue $workerHash
$identity.agent|Add-Member -NotePropertyName unsignedHelperSha256 -NotePropertyValue $helperHash
Assert-Stage4UnsignedBuildChain $identity $records
foreach($link in @(
    @('worker','unsignedMediaSha256',$mediaHash),
    @('helper','unsignedWorkerSha256',$workerHash),
    @('agent','unsignedHelperSha256',$helperHash)
)){
    $identity.($link[0]).($link[1])='12'*32
    Assert-Rejected {Assert-Stage4UnsignedBuildChain $identity $records} "stage4_unsigned_build_chain_mismatch:$($link[0])"
    $identity.($link[0]).($link[1])=$link[2]
}
$records[0].sha256='34'*32
Assert-Rejected {Assert-Stage4UnsignedBuildChain $identity $records} 'stage4_unsigned_build_chain_mismatch:worker'
$records[0].sha256=$mediaHash
Assert-Rejected {Assert-Stage4UnsignedBuildChain $identity ($records+@($records[0]))} 'stage4_unsigned_build_chain_mismatch:worker'
Assert-Stage4UnsignedBuildChain $identity $records
Write-Host 'Unsigned build chain evidence tests passed (no installation authority).'
