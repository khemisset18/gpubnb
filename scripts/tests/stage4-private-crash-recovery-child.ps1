#Requires -Version 5.1
param([string]$Root,[string]$CrashAt='', [switch]$Recover)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'stage4-private-four-file-transaction-core.ps1')
# The real core/recovery validates the TEMP-only fixture scope again.
$target=Join-Path $Root 'installed'
$state=Join-Path $Root 'fake-service-running'
$callbacks=@{
    TargetDirectory=$target
    StopControlledService={Remove-Item -LiteralPath $state -Force -ErrorAction SilentlyContinue}
    StartControlledService={[IO.File]::WriteAllText($state,'running')}
    IsControlledServiceRunning={Test-Path -LiteralPath $state}
    IsControlledServiceStopped={-not (Test-Path -LiteralPath $state)}
    ValidateControlledRuntime={$true}
}
$checkpoint={param($step) if($step -ceq $CrashAt){[Diagnostics.Process]::GetCurrentProcess().Kill();throw 'kill_failed'}}
if($Recover) {
    Invoke-Stage4FourFileRecovery @callbacks -RecoveryCheckpoint $checkpoint | Out-Null
} else {
    $pins=Get-Content -LiteralPath (Join-Path $Root 'pins.json') -Raw | ConvertFrom-Json
    $old=@{};$new=@{};$sddl=@{}
    foreach($pin in $pins){$old[$pin.name]=$pin.oldHash;$new[$pin.name]=$pin.newHash;$sddl[$pin.name]=$pin.sddl}
    Invoke-Stage4FourFileTransactionCore @callbacks -CandidateDirectory (Join-Path $Root 'candidate') `
        -OldHashes $old -NewHashes $new -OldSddl $sddl -TransactionCheckpoint $checkpoint | Out-Null
}
