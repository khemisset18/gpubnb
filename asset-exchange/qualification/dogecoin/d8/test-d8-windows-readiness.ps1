# Smoke and safety assertions on a real Windows GitHub Actions host.
# A GitHub-hosted runner often has no WSL2 distro, which is NOT a test failure.
$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "d8-windows-readiness.ps1"
$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
    $scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
    throw "Windows preflight PowerShell syntax errors: $($parseErrors.Count)"
}
$raw = & $scriptPath
$report = ($raw | Out-String | ConvertFrom-Json)
if ($report.schemaVersion -ne 1) { throw "wrong schema" }
if ($report.scope -ne "WINDOWS_READ_ONLY_D8_SOFTWARE_LAB_READINESS") { throw "wrong scope" }
if ($report.classification -notin @(
        "WINDOWS_SOFTWARE_LAB_PREREQUISITE_READY",
        "WINDOWS_SOFTWARE_LAB_SETUP_REQUIRED")) { throw "classification not bounded" }
if ($report.classification -eq "WINDOWS_SOFTWARE_LAB_PREREQUISITE_READY" -and
    (-not $report.windowsBuildSupportsModernWSL -or -not $report.wsl2DistributionListed -or
     -not $report.wslListingSucceeded)) {
    throw "false WSL readiness"
}
foreach ($name in @(
    "privateRegtestExecutedOnThisPC",
    "physicalDeviceConnected",
    "physicalD8Qualified",
    "hardwareH8_1_to_H8_5Complete",
    "walletAccessAttempted",
    "keysRead")) {
    if ($report.$name -ne $false) { throw "unsafe qualification or key-access claim: $name" }
}
if ($report.realDogeUsed -ne 0 -or $report.broadcasts -ne 0) {
    throw "funding or broadcast claim"
}
if ([string]::IsNullOrWhiteSpace($report.nextAction)) { throw "missing next step" }
$path = Join-Path $env:RUNNER_TEMP "d8-windows-readiness.json"
if (Test-Path -LiteralPath $path) { throw "report destination exists before test" }
$null = & $scriptPath -OutputFile $path
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "missing opt-in report" }
$written = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
if ($written.scope -ne $report.scope) { throw "report corrupted" }
$replacementBlocked = $false
try {
    $null = & $scriptPath -OutputFile $path
} catch {
    $replacementBlocked = $true
}
if (-not $replacementBlocked) { throw "preflight overwrote prior evidence" }
Write-Host "WINDOWS_D8_READONLY_PREFLIGHT_TESTS=PASS"
Write-Host ("WSL2_CONFIGURED_ON_RUNNER=" + $report.wsl2DistributionListed)
Write-Host "PHYSICAL_D8_QUALIFIED=false"
