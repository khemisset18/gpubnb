param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'

$installer = Get-Item -LiteralPath $InstallerPath -ErrorAction Stop
if ($installer.Length -lt 262144) {
    throw "Windows installer is unexpectedly small: $($installer.Length) bytes."
}
$bytes = [System.IO.File]::ReadAllBytes($installer.FullName)
if ($bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
    throw 'Windows installer is not a valid PE file (missing MZ header).'
}

$pyprojectPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'agent\pyproject.toml'
$pyproject = Get-Content -LiteralPath $pyprojectPath -Raw -ErrorAction Stop
$versionMatch = [regex]::Match($pyproject, '(?m)^version\s*=\s*"([^"]+)"\s*$')
if (-not $versionMatch.Success) {
    throw 'Unable to determine expected Agent version from agent/pyproject.toml.'
}
$expectedAgentVersion = $versionMatch.Groups[1].Value

$installDirectory = Join-Path $env:RUNNER_TEMP ("gpubnb-release-smoke-" + [guid]::NewGuid().ToString('N'))
try {
    $installation = Start-Process -FilePath $installer.FullName -ArgumentList '/S', "/D=$installDirectory" -Wait -PassThru
    if ($installation.ExitCode -ne 0) {
        throw "NSIS silent installation failed with exit code $($installation.ExitCode)."
    }

    $sidecar = Join-Path $installDirectory 'gpubnb-agent.exe'
    $tunnel = Join-Path $installDirectory 'gpubnb-host-tunnel.exe'
    if (-not (Test-Path $sidecar -PathType Leaf)) {
        throw 'Published installer does not contain gpubnb-agent.exe.'
    }
    if (-not (Test-Path $tunnel -PathType Leaf)) {
        throw 'Published installer does not contain gpubnb-host-tunnel.exe.'
    }
    if ((Get-Item $tunnel).Length -lt 262144) {
        throw 'Installed Host tunnel sidecar is unexpectedly small.'
    }
    $tunnelBytes = [System.IO.File]::ReadAllBytes($tunnel)
    if ($tunnelBytes[0] -ne 0x4D -or $tunnelBytes[1] -ne 0x5A) {
        throw 'Installed Host tunnel sidecar is not a valid Windows PE file.'
    }

    $installedAgentVersion = (& $sidecar version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Installed agent version command failed.' }
    if ($installedAgentVersion -ne $expectedAgentVersion) {
        throw "Installed Agent version mismatch: expected $expectedAgentVersion, got $installedAgentVersion."
    }

    & $sidecar runtime-check
    if ($LASTEXITCODE -ne 0) { throw 'Installed agent runtime-check failed.' }

    $service = Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'"
    if (-not $service) { throw 'Published installer did not register GPUbnbAgent.' }
    if ($service.StartMode -ne 'Auto') { throw "GPUbnbAgent is not automatic: $($service.StartMode)" }
    if ($service.PathName -notlike "*$sidecar*") {
        throw "GPUbnbAgent does not point to installed sidecar: $($service.PathName)"
    }

    & $sidecar service restart
    if ($LASTEXITCODE -ne 0) { throw 'Published installer service restart failed.' }
    $service = Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'"
    if ($service.State -ne 'Running') { throw "GPUbnbAgent is not running after restart: $($service.State)" }

    $uninstaller = Join-Path $installDirectory 'uninstall.exe'
    if (-not (Test-Path $uninstaller -PathType Leaf)) {
        throw 'Published installer did not install uninstall.exe.'
    }
    $uninstallation = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
    if ($uninstallation.ExitCode -ne 0) {
        throw "Silent uninstall failed with exit code $($uninstallation.ExitCode)."
    }
    if (Test-Path $sidecar) { throw 'Uninstaller left gpubnb-agent.exe behind.' }
    if (Test-Path $tunnel) { throw 'Uninstaller left gpubnb-host-tunnel.exe behind.' }
    if (Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'") {
        throw 'Uninstaller left GPUbnbAgent registered.'
    }
} finally {
    if (Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'" -ErrorAction SilentlyContinue) {
        try { sc.exe stop GPUbnbAgent | Out-Null } catch {}
        try { sc.exe delete GPUbnbAgent | Out-Null } catch {}
    }
    if (Test-Path $installDirectory) {
        Remove-Item -Recurse -Force $installDirectory -ErrorAction SilentlyContinue
    }
}
