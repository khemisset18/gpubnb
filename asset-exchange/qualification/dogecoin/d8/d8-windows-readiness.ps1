# GPUbnb DOGE D8 zero-funds Windows-to-WSL2 readiness diagnostic.
# PowerShell 5.1+ / Windows 10 or 11. Does NOT install WSL, launch a node,
# read wallets, connect to the network, touch DOGE, or qualify any hardware.
[CmdletBinding()]
param(
    [string] $OutputFile = ""
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "This diagnostic must run in Windows PowerShell (not inside WSL/Linux)."
}

$build = [int][Environment]::OSVersion.Version.Build
$winSupported = $build -ge 19041
$wsl = Get-Command "wsl.exe" -ErrorAction SilentlyContinue
$wslAvailable = $null -ne $wsl
$wsl2Distro = $false
$wslProbeSucceeded = $false
$wslCheckError = $false
if ($wslAvailable) {
    try {
        # Read-only listing; distro names, host usernames and errors are NOT
        # retained in the published result.
        $lines = (& wsl.exe --list --verbose 2>&1 | Out-String) -replace "\x00", ""
        $code = $LASTEXITCODE
        if ($code -eq 0) {
            $wslProbeSucceeded = $true
            # Version number is independent of the localized STATE column.
            # Do not trust the default WSL version: require a *listed distro*.
            foreach ($line in ($lines -split "\r?\n")) {
                if ($line -match '^\s*\*?\s*\S.*\s+2\s*$') {
                    $wsl2Distro = $true
                }
            }
        } else {
            $wslCheckError = $true
        }
    } catch {
        $wslCheckError = $true
    }
}

# Defense-in-depth observations only: these are not security attestation.
$defenderState = "unknown"
try {
    $mp = Get-MpComputerStatus -ErrorAction Stop
    if ($null -ne $mp) {
        $defenderState = if ($mp.RealTimeProtectionEnabled -eq $true) { "enabled" }
                         elseif ($mp.RealTimeProtectionEnabled -eq $false) { "disabled" }
                         else { "unknown" }
    }
} catch {
    # Third-party antivirus, permissions or unsupported cmdlets may hide status.
}
$firewallState = "unknown"
try {
    $profiles = @(Get-NetFirewallProfile -ErrorAction Stop)
    if ($profiles.Count -ge 3) {
        $firewallState = if (@($profiles | Where-Object { $_.Enabled -ne $true }).Count -eq 0) {
            "enabled_all_profiles"
        } else { "one_or_more_profiles_disabled" }
    }
} catch {
    # No security assertion from missing inspection permissions.
}

$ready = $winSupported -and $wslAvailable -and $wslProbeSucceeded -and $wsl2Distro
$next = if (-not $winSupported) {
    "Windows build below 19041; check Microsoft WSL2 support before installing anything."
} elseif (-not $wslAvailable -or -not $wslProbeSucceeded) {
    "In regular PowerShell, run: wsl --status ; wsl --list --verbose"
} elseif (-not $wsl2Distro) {
    "A WSL2 Linux distribution is not yet shown. See official Microsoft WSL installation instructions."
} else {
    "Windows WSL2 prerequisite found; Linux namespace and Dogecoin tests still require independent checks."
}
$report = [ordered]@{
    schemaVersion = 1
    scope = "WINDOWS_READ_ONLY_D8_SOFTWARE_LAB_READINESS"
    windowsBuild = $build
    windowsBuildSupportsModernWSL = $winSupported
    wslCommandPresent = [bool]$wslAvailable
    wslListingSucceeded = [bool]$wslProbeSucceeded
    wslListingError = [bool]$wslCheckError
    wsl2DistributionListed = [bool]$wsl2Distro
    defenderRealtimeStatus = $defenderState
    firewallProfilesStatus = $firewallState
    classification = if ($ready) { "WINDOWS_SOFTWARE_LAB_PREREQUISITE_READY" }
                     else { "WINDOWS_SOFTWARE_LAB_SETUP_REQUIRED" }
    nextAction = $next
    privateRegtestExecutedOnThisPC = $false
    physicalDeviceConnected = $false
    physicalD8Qualified = $false
    hardwareH8_1_to_H8_5Complete = $false
    walletAccessAttempted = $false
    keysRead = $false
    realDogeUsed = 0
    broadcasts = 0
}
$json = ConvertTo-Json -InputObject $report -Depth 4
if (-not [string]::IsNullOrWhiteSpace($OutputFile)) {
    # Explicit opt-in; never silently modify existing evidence.
    $destination = [IO.Path]::GetFullPath($OutputFile)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $stream = New-Object System.IO.FileStream(
        $destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = $utf8.GetBytes($json + [Environment]::NewLine)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
}
# A missing WSL2 distro is a *reported readiness state*, not a failing native
# executable test. Reset the diagnostic's native exit code after inspection;
# PowerShell exceptions and file-write errors still fail closed.
$global:LASTEXITCODE = 0
Write-Output $json
