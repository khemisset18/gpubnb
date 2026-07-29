#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs the standalone GPUbnb agent as a Windows Service.
.DESCRIPTION
  This compatibility entry point never downloads Python and never creates a
  scheduled task. Production installations should use the signed GPUbnb Host
  NSIS installer, which invokes the same service commands automatically.
.PARAMETER AgentPath
  Path to the frozen gpubnb-agent.exe sidecar.
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$AgentPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$resolvedAgent = (Resolve-Path -LiteralPath $AgentPath).Path
if ([IO.Path]::GetFileName($resolvedAgent) -ne "gpubnb-agent.exe") {
    throw "AgentPath must point to gpubnb-agent.exe."
}

& $resolvedAgent version
if ($LASTEXITCODE -ne 0) {
    throw "The standalone GPUbnb agent is not executable."
}

& $resolvedAgent service install
if ($LASTEXITCODE -ne 0) {
    throw "The GPUbnb Windows Service could not be installed."
}

& $resolvedAgent service start
if ($LASTEXITCODE -ne 0) {
    throw "The GPUbnb Windows Service could not be started."
}

$service = Get-CimInstance Win32_Service -Filter "Name='GPUbnbAgent'"
if (-not $service -or $service.StartMode -ne "Auto" -or $service.State -ne "Running") {
    throw "The GPUbnb Windows Service did not reach the required running/automatic state."
}

Write-Host "GPUbnbAgent is installed, automatic, and running."
