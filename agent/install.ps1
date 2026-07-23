#Requires -Version 5.1
<#
.SYNOPSIS
  GPUbnb Agent installer for Windows.
.DESCRIPTION
  Installs Python, dependencies, the GPUbnb Agent package, creates a
  configuration directory, performs a first hardware scan, and optionally
  links the machine to a GPUbnb account.
.PARAMETER ApiUrl
  The GPUbnb API endpoint (default: https://gpubnb.netlify.app/api).
.PARAMETER LinkCode
  Optional link code to register the machine immediately after install.
.EXAMPLE
  .\install.ps1 -LinkCode ABC123DEF4
#>
param(
    [string]$ApiUrl = "https://gpubnb.netlify.app/api",
    [string]$LinkCode
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Err([string]$msg)  { Write-Host "  [ERR] $msg" -ForegroundColor Red }

# --- 1. Check Python -----------------------------------------------------------
Write-Step "Verification de Python"
$pythonCmd = $null
foreach ($cmd in @("python", "python3", "py")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3\.(1[1-9]|[2-9][0-9])") {
            $pythonCmd = $cmd
            Write-Ok "Python detecte: $ver"
            break
        }
    } catch { }
}
if (-not $pythonCmd) {
    Write-Step "Installation de Python 3.12"
    $installer = "$env:TEMP\python-installer.exe"
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe" -OutFile $installer
    Start-Process -FilePath $installer -ArgumentList "/quiet", "InstallAllUsers=1", "PrependPath=1", "Include_pip=1" -Wait
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $pythonCmd = "python"
    Write-Ok "Python 3.12 installe"
}

# --- 2. Install agent package --------------------------------------------------
Write-Step "Installation du GPUbnb Agent"
$agentDir = Split-Path -Parent $PSScriptRoot
Push-Location $agentDir
& $pythonCmd -m pip install --upgrade pip 2>&1 | Out-Null
& $pythonCmd -m pip install -e . 2>&1 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { Write-Err "Echec d'installation pip"; exit 1 }
Write-Ok "Agent installe"
Pop-Location

# --- 3. Configure API URL ------------------------------------------------------
Write-Step "Configuration"
$configDir = Join-Path $env:USERPROFILE ".gpubnb"
if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
$configFile = Join-Path $configDir "config.json"
$config = @{ apiUrl = $ApiUrl }
$config | ConvertTo-Json | Set-Content $configFile -Encoding UTF8
Write-Ok "Configuration cree: $configFile"

# --- 4. First hardware scan ----------------------------------------------------
Write-Step "Scan materiel initial"
& $pythonCmd -m gpubnb_agent diagnose 2>&1 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { Write-Err "Le scan a rencontre des avertissements (non bloquant)" }
Write-Ok "Scan termine"

# --- 5. Link machine (optional) ------------------------------------------------
if ($LinkCode) {
    Write-Step "Liaison de la machine avec le code: $LinkCode"
    & $pythonCmd -m gpubnb_agent link $LinkCode 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -eq 0) { Write-Ok "Machine liee" } else { Write-Err "Echec de liaison" }
}

# --- 6. Create scheduled task for auto-start -----------------------------------
Write-Step "Configuration du demarrage automatique"
$taskName = "GPUbnbAgent"
try {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
} catch { }
$action = New-ScheduledTaskAction -Execute $pythonCmd -Argument "-m gpubnb_agent start"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Ok "Tache planifiee creee (demarrage a la connexion)"

# --- Done ---------------------------------------------------------------------
Write-Step "Installation terminee"
Write-Host ""
Write-Host "  Pour demarrer l'agent maintenant :  $pythonCmd -m gpubnb_agent start" -ForegroundColor Yellow
Write-Host "  Pour scanner le materiel :          $pythonCmd -m gpubnb_agent diagnose" -ForegroundColor Yellow
Write-Host "  Pour lier la machine :               $pythonCmd -m gpubnb_agent link CODE" -ForegroundColor Yellow
Write-Host ""
