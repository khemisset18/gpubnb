#Requires -Version 5.1
# Abrupt process termination, no real services or machines. This is NOT power loss.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe','gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
$steps=@('journal-prepared')+@($names | ForEach-Object {'staged-'+$_})+@('service-stopped')+
    @($names | ForEach-Object {'old-renamed-'+$_;'new-renamed-'+$_})+@('runtime-healthy','journal-committed')
$exe=(Get-Process -Id $PID).Path
$child=Join-Path $PSScriptRoot 'stage4-private-crash-recovery-child.ps1'
function Run-Child([string]$Root,[string]$Step,[bool]$Recover) {
    $args=@('-NoProfile','-NonInteractive','-File',$child,'-Root',$Root)
    if($Step){$args+=@('-CrashAt',$Step)}
    if($Recover){$args+='-Recover'}
    $savedPreference=$ErrorActionPreference
    try {
        $ErrorActionPreference='Continue'
        & $exe @args > (Join-Path $Root 'child.log') 2>&1
        $code=$LASTEXITCODE
    } finally {$ErrorActionPreference=$savedPreference}
    return $code
}
foreach($step in $steps) {
    $root=Join-Path $env:TEMP ('GPUbnb-stage4-maintenance-test-'+[Guid]::NewGuid().ToString('N'))
    $target=Join-Path $root 'installed';$candidate=Join-Path $root 'candidate'
    [void](New-Item -ItemType Directory -Path $target,$candidate)
    $pins=@()
    foreach($name in $names) {
        $live=Join-Path $target $name;$new=Join-Path $candidate $name
        [IO.File]::WriteAllText($live,('old-'+$name));[IO.File]::WriteAllText($new,('new-'+$name))
        $pins+=@([pscustomobject]@{name=$name;oldHash=(Get-FileHash $live).Hash;newHash=(Get-FileHash $new).Hash;sddl=(Get-Acl $live).Sddl})
    }
    $pins | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'pins.json')
    [IO.File]::WriteAllText((Join-Path $root 'fake-service-running'),'running')
    try {
        if((Run-Child $root $step $false) -eq 0) {throw ('expected_process_death:'+ $step)}
        if($step -ceq 'new-renamed-gpubnb-agent.exe') {
            # Crash recovery itself in the gap between removing live and restoring backup.
            if((Run-Child $root 'recovery-removed-gpubnb-agent.exe' $true) -eq 0) {throw 'expected_recovery_process_death'}
        }
        foreach($attempt in 1..2) {
            if((Run-Child $root '' $true) -ne 0) {throw ('recovery_failed:'+ $step+':'+(Get-Content (Join-Path $root 'child.log') -Raw))}
            foreach($pin in $pins) {
                $live=Join-Path $target $pin.name
                $expected=if($step -ceq 'journal-committed'){$pin.newHash}else{$pin.oldHash}
                if((Get-FileHash $live).Hash -cne $expected -or (Get-Acl $live).Sddl -cne $pin.sddl) {throw ('bad_recovery_pin:'+ $step)}
            }
        }
        # Tampering must fail before stopping the simulated service.
        $journal=Join-Path $target '.stage4-transaction.json'
        $saved=Get-Content -LiteralPath $journal -Raw
        [IO.File]::WriteAllText($journal,($saved.Replace($names[0],'..\outside.exe')))
        if((Run-Child $root '' $true) -eq 0){throw 'tampered_journal_accepted'}
        if(-not (Test-Path (Join-Path $root 'fake-service-running'))){throw 'tampered_journal_stopped_service'}
        Write-Host ('PASS fresh-process crash recovery and idempotence: '+$step)
    } finally {Remove-Item -LiteralPath $root -Recurse -Force}
}
# The final tamper-rejection child intentionally exits nonzero. GitHub Actions
# reads $LASTEXITCODE in its calling PowerShell scope after this script returns.
# A plain $LASTEXITCODE assignment here only updates this script's scope, leaving
# the caller with the child's failure code even though all assertions passed.
# Reset the caller-visible value only after the complete suite succeeds; any
# assertion failure still throws before this line.
$global:LASTEXITCODE = 0
