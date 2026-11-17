#Requires -Version 5.1
# Regression for PC1 expired backup + untrusted machine signer (2026-11-15).
# Synthetic read-only policy tests. Never touches PC1 or a real service.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$scripts=Split-Path -Parent $PSScriptRoot
$core=Join-Path $scripts 'stage4-private-four-file-transaction-core.ps1'
$readiness=Join-Path $scripts 'stage4-private-install-readiness.ps1'
$offline=Join-Path $scripts 'stage4-private-offline-rollback-drill.ps1'
$maintenance=Join-Path $scripts 'stage4-private-four-file-maintenance.ps1'
$recovery=Join-Path $scripts 'stage4-private-four-file-recover.ps1'

foreach($path in @($core,$readiness,$offline,$maintenance,$recovery)) {
    $tokens=$null
    $errors=$null
    [void][Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
    if($errors.Count -ne 0) {
        throw ('stage4_expired_rescue_parser_failure:'+ (Split-Path -Leaf $path)+':'+$errors[0].Message)
    }
}
. $core

$names=@(
    'nonoverlapping-real-folders',
    'new-package-complete-signed-pinned',
    'old-backup-hashes-signatures-acls',
    'machine-context-publisher-chain',
    'known-service-process-topology',
    'expected-gpu-uuid'
)
$allPassed=[pscustomobject]@{
    kind='STAGE4_PC1_PRIVATE_INSTALL_READINESS_READONLY'
    localPreflightPassed=$true
    installAuthorized=$false
    checks=@($names | ForEach-Object {
        [pscustomobject]@{name=$_;passed=$true;detail='synthetic'}
    })
}
if(-not (Assert-Stage4MaintenanceReadiness -Readiness $allPassed)){
    throw 'stage4_expired_rescue_positive_fixture_rejected'
}

function Reject-InvalidReadiness {
    param([string]$Label,[string[]]$FailedChecks)
    $report=ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $allPassed -Depth 8)
    foreach($check in $report.checks) {
        if($check.name -in $FailedChecks){
            $check.passed=$false
            $check.detail='expired-signature-or-UntrustedRoot'
        }
    }
    # Even if an attacker/bug sets the aggregate flag true, the individual
    # failing gates must reject before any physical service stop.
    $report.localPreflightPassed=$true
    $denied=$false
    try { [void](Assert-Stage4MaintenanceReadiness -Readiness $report) }
    catch { $denied=$true }
    if(-not $denied){throw ('stage4_expired_rescue_fail_open:'+ $Label)}
    Write-Host ('PASS fail closed: '+$Label)
}
Reject-InvalidReadiness 'expired historical backup' @('old-backup-hashes-signatures-acls')
Reject-InvalidReadiness 'untrusted machine code signer' @('machine-context-publisher-chain')
Reject-InvalidReadiness 'both current PC1 blockers' @(
    'old-backup-hashes-signatures-acls',
    'machine-context-publisher-chain'
)

$readinessText=Get-Content -LiteralPath $readiness -Raw
$offlineText=Get-Content -LiteralPath $offline -Raw
$maintenanceText=Get-Content -LiteralPath $maintenance -Raw
$recoveryText=Get-Content -LiteralPath $recovery -Raw

# Matching hashes alone are insufficient: retain current Authenticode checks
# and the >24 h validity window for backed-up AND live old binaries.
if($readinessText -notmatch 'old-backup-hashes-signatures-acls' -or
    $readinessText -notmatch 'Get-AuthenticodeSignature' -or
    $readinessText -notmatch '\$sig\.Status -ne ''Valid''' -or
    $readinessText -notmatch 'NotAfter\.ToUniversalTime\(\)' -or
    $readinessText -notmatch 'AddHours\(24\)' -or
    $readinessText -notmatch 'machine-context-publisher-chain' -or
    $readinessText -notmatch 'X509Chain\]::new\(\$true\)' -or
    $readinessText -notmatch '\$machineChain\.Build\(' -or
    $readinessText -notmatch 'installAuthorized=\$false') {
    throw 'stage4_expired_rescue_readiness_gate_weakened'
}
# A separate successful byte-only scratch exercise NEVER overrides six gates.
if($offlineText -notmatch '\$readiness\.localPreflightPassed -cne \$true' -or
    $offlineText -notmatch 'stage4_offline_local_preflight_failed' -or
    $offlineText -notmatch 'installationAuthorized=\$false') {
    throw 'stage4_expired_rescue_offline_guard_weakened'
}
if($maintenanceText -notmatch 'Assert-Stage4MaintenanceReadiness' -or
    $maintenanceText -notmatch 'stage4_maintenance_explicit_operator_approval_required' -or
    $recoveryText -notmatch '\[switch\]\$OperatorPresentAndApproved' -or
    $recoveryText -notmatch 'Get-AuthenticodeSignature' -or
    $recoveryText -notmatch 'stage4_recovery_machine_identity_mismatch') {
    throw 'stage4_expired_rescue_physical_guard_weakened'
}
foreach($source in @($readinessText,$offlineText,$maintenanceText,$recoveryText)) {
    if($source -match '\b(?:Import-Certificate|Unblock-File|Set-ExecutionPolicy)\b') {
        throw 'stage4_expired_rescue_forbidden_trust_or_execution_policy_change'
    }
}
Write-Host 'PASS expired-backup and machine-trust controls retained in official scripts'
Write-Host 'PASS physical maintenance requires readiness and separate operator approval'
Write-Host 'PASS all test inputs synthetic; no PC1 changes'
