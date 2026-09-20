[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9_-]{1,128}$')]
    [string]$SessionId,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 4294967295)]
    [uint32]$WindowsSessionId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^GPU-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$')]
    [string]$GpuUuid,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^S-1-(?:[0-9]+-){2,14}[0-9]+$')]
    [string]$RenterUserSid,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^S-1-(?:[0-9]+-){2,14}[0-9]+$')]
    [string]$ProviderUserSid,

    [ValidateRange(1, 18446744073709551615)]
    [UInt64]$Generation = 1,

    [ValidateRange(1, 120)]
    [int]$Frames = 8,

    [string]$HarnessPath = (Join-Path $PSScriptRoot '..\..\native\windows-stream-helper\target\release\gpubnb-windows-physical-qualify.exe'),

    [string]$EvidencePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-QualificationPrerequisite {
    param([bool]$Condition, [string]$Code)
    if (-not $Condition) {
        throw $Code
    }
}

Assert-QualificationPrerequisite ($env:OS -eq 'Windows_NT') 'physical_qualification_windows_required'

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Assert-QualificationPrerequisite ($currentSid -eq 'S-1-5-18') 'physical_qualification_local_system_required'
Assert-QualificationPrerequisite ($RenterUserSid -ne $ProviderUserSid) 'physical_qualification_renter_provider_sid_must_differ'
Assert-QualificationPrerequisite ($RenterUserSid -notin @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')) 'physical_qualification_renter_system_sid_forbidden'

$resolvedHarness = (Resolve-Path -LiteralPath $HarnessPath -ErrorAction Stop).Path
$workerPath = 'C:\Program Files\GPUbnb\gpubnb-windows-worker.exe'
$mediaDllPath = 'C:\Program Files\GPUbnb\GPUbnbWindowsMedia.dll'
Assert-QualificationPrerequisite (Test-Path -LiteralPath $workerPath -PathType Leaf) 'physical_qualification_worker_missing'
Assert-QualificationPrerequisite (Test-Path -LiteralPath $mediaDllPath -PathType Leaf) 'physical_qualification_media_dll_missing'

foreach ($trustedPath in @($workerPath, $mediaDllPath)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $trustedPath
    Assert-QualificationPrerequisite ($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid) 'physical_qualification_component_signature_invalid'
}

$nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
Assert-QualificationPrerequisite ($null -ne $nvidiaSmi) 'physical_qualification_nvidia_smi_missing'
$localGpuUuids = @(
    & $nvidiaSmi.Source --query-gpu=uuid --format=csv,noheader |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -match '^GPU-[0-9A-Fa-f-]{36}$' }
)
Assert-QualificationPrerequisite ($LASTEXITCODE -eq 0) 'physical_qualification_nvidia_inventory_failed'
Assert-QualificationPrerequisite ($localGpuUuids -icontains $GpuUuid) 'physical_qualification_gpu_uuid_not_local'

$idd = @(
    Get-PnpDevice -PresentOnly -ErrorAction Stop |
        Where-Object {
            $_.InstanceId -like 'ROOT\GPUbnbVirtualDisplay*' -or
            $_.FriendlyName -eq 'GPUbnb Isolated Virtual Display'
        }
)
Assert-QualificationPrerequisite ($idd.Count -eq 1) 'physical_qualification_idd_device_missing_or_ambiguous'
Assert-QualificationPrerequisite ($idd[0].Status -eq 'OK') 'physical_qualification_idd_device_not_ready'

$arguments = @(
    '--session-id', $SessionId,
    '--generation', [string]$Generation,
    '--gpu-uuid', $GpuUuid,
    '--windows-session-id', [string]$WindowsSessionId,
    '--renter-user-sid', $RenterUserSid,
    '--provider-user-sid', $ProviderUserSid,
    '--frames', [string]$Frames
)

$stdout = (& $resolvedHarness @arguments | Out-String).Trim()
$exitCode = $LASTEXITCODE
Assert-QualificationPrerequisite ($exitCode -eq 0) "physical_qualification_harness_failed_$exitCode"

try {
    $result = $stdout | ConvertFrom-Json -ErrorAction Stop
}
catch {
    throw 'physical_qualification_harness_invalid_json'
}

foreach ($field in @(
    'ok',
    'isolatedSession',
    'virtualDisplay',
    'providerDesktopExcluded',
    'exactGpuBound',
    'loopbackMedia',
    'cleanupVerified'
)) {
    Assert-QualificationPrerequisite ($result.$field -ceq $true) "physical_qualification_missing_$field"
}
Assert-QualificationPrerequisite ($result.hardwareEncoder -ceq 'nvenc') 'physical_qualification_nvenc_required'
Assert-QualificationPrerequisite ($result.bookabilityEnabled -ceq $false) 'physical_qualification_must_not_enable_bookability'
Assert-QualificationPrerequisite ([int]$result.frames -eq $Frames) 'physical_qualification_frame_count_mismatch'

$os = Get-CimInstance Win32_OperatingSystem
$gpuRows = @(
    & $nvidiaSmi.Source --query-gpu=name,uuid,driver_version,memory.total --format=csv,noheader,nounits |
        ForEach-Object { $_.Trim() }
)
Assert-QualificationPrerequisite ($LASTEXITCODE -eq 0) 'physical_qualification_nvidia_evidence_failed'

$evidence = [ordered]@{
    schemaVersion = 1
    qualifiedAtUtc = [DateTime]::UtcNow.ToString('o')
    result = 'PASS'
    workspace = 'cloud-desktop'
    windows = [ordered]@{
        caption = [string]$os.Caption
        version = [string]$os.Version
        buildNumber = [string]$os.BuildNumber
    }
    gpuUuid = $GpuUuid
    gpuInventory = $gpuRows
    frames = $Frames
    artifacts = [ordered]@{
        harnessSha256 = (Get-FileHash -LiteralPath $resolvedHarness -Algorithm SHA256).Hash.ToLowerInvariant()
        workerSha256 = (Get-FileHash -LiteralPath $workerPath -Algorithm SHA256).Hash.ToLowerInvariant()
        mediaDllSha256 = (Get-FileHash -LiteralPath $mediaDllPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    proofs = [ordered]@{
        isolatedSession = $true
        virtualDisplay = $true
        providerDesktopExcluded = $true
        exactGpuBound = $true
        hardwareEncoder = 'nvenc'
        loopbackMedia = $true
        cleanupVerified = $true
    }
    windowsNativeBookabilityEnabled = $false
    physicalWindowsNvidiaQualification = 'SMOKE_STAGE_2_ONLY'
}

$json = $evidence | ConvertTo-Json -Depth 8

if ($EvidencePath) {
    $parent = Split-Path -Parent $EvidencePath
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText(
        [IO.Path]::GetFullPath($EvidencePath),
        $json + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )
}

Write-Output $json
