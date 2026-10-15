#Requires -Version 5.1
<#
.SYNOPSIS
  GPUbnb Stage 4 PC1 read-only inventory. Does not qualify or install anything.
.DESCRIPTION
  Checks known install paths, SHA-256 hashes, service state, AMD64 VC++ runtime
  versions, and candidate IddCx display-driver metadata. No executables are
  launched, no signatures/keys/certificate stores are inspected, no files are
  written, and no network calls are made.
  Run only on the provider's PC1, never on the browser-only PC2.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT' -or
    $PSVersionTable.PSEdition -ne 'Desktop' -or
    $PSVersionTable.PSVersion.Major -ne 5 -or
    -not [Environment]::Is64BitProcess) {
    throw 'stage4_pc1_requires_64bit_windows_powershell_51'
}

function Get-FileEvidence {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        $item = Get-Item -LiteralPath $Path -ErrorAction Stop
        $hash = Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop
        return [ordered]@{
            path = $item.FullName
            bytes = [int64]$item.Length
            sha256 = $hash.Hash.ToLowerInvariant()
        }
    }
    catch {
        return [ordered]@{ path = $Path; error = 'cannot_read_file' }
    }
}

$root = Join-Path $env:ProgramFiles 'GPUbnb'
$knownDirectories = @($root, (Join-Path $root 'bin'))
$components = [ordered]@{}
$names = [ordered]@{
    agent = 'gpubnb-agent.exe'
    helper = 'gpubnb-windows-stream.exe'
    worker = 'gpubnb-windows-worker.exe'
    mediaDll = 'GPUbnbWindowsMedia.dll'
}
foreach ($name in $names.Keys) {
    $matches = @()
    foreach ($directory in $knownDirectories) {
        $path = Join-Path $directory $names[$name]
        $found = Get-FileEvidence -Path $path
        if ($null -ne $found) { $matches += $found }
    }
    $components[$name] = @($matches)
}

$service = [ordered]@{ querySucceeded = $false; exists = $false }
try {
    $foundService = Get-CimInstance -ClassName Win32_Service -Filter "Name='GPUbnbAgent'" -ErrorAction Stop
    $service.querySucceeded = $true
    if ($null -ne $foundService) {
        $service.exists = $true
        $service.state = [string]$foundService.State
        $service.startMode = [string]$foundService.StartMode
    }
}
catch {
    $service.error = 'service_query_unavailable'
}

$vcRuntime = [ordered]@{}
foreach ($name in @('VCRUNTIME140.dll', 'VCRUNTIME140_1.dll', 'MSVCP140.dll', 'ucrtbase.dll')) {
    $path = Join-Path $env:windir ("System32\\" + $name)
    $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
    $vcRuntime[$name] = [ordered]@{
        present = ($null -ne $item)
        fileVersion = if ($null -ne $item) { [string]$item.VersionInfo.FileVersion } else { $null }
    }
}

$displayDrivers = [ordered]@{ querySucceeded = $false; matches = @() }
try {
    $drivers = @(Get-CimInstance -ClassName Win32_PnPSignedDriver -ErrorAction Stop)
    $displayDrivers.querySucceeded = $true
    $displayDrivers.matches = @(
        foreach ($driver in $drivers) {
            $device = [string]$driver.DeviceName
            $inf = [string]$driver.InfName
            if ($device -match '(?i)gpubnb|iddcx|indirect display' -or
                $inf -match '(?i)gpubnb|iddcx') {
                [ordered]@{
                    deviceName = $device
                    infName = $inf
                    driverVersion = [string]$driver.DriverVersion
                    isSigned = $driver.IsSigned
                }
            }
        }
    )
}
catch {
    $displayDrivers.error = 'pnp_driver_query_unavailable'
}

$report = [ordered]@{
    schemaVersion = 1
    role = 'PC1_windows_nvidia_host'
    collection = 'read_only_no_network_no_execution'
    collectedAtUtc = [DateTime]::UtcNow.ToString('o')
    componentsInKnownDirectories = $components
    service = $service
    amd64Runtime = $vcRuntime
    candidateDisplayDrivers = $displayDrivers
    limitations = @(
        'Known paths only; no match does not prove file absent elsewhere',
        'Installed hashes may differ from unsigned build because signing changes bytes',
        'No Authenticode, key, certificate, pin, runtime or physical qualification performed',
        'Driver name filtering may miss the installed IddCx package',
        'Do not install or replace binaries based on this inventory'
    )
}
$report | ConvertTo-Json -Depth 8
