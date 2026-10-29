#Requires -Version 5.1
# Read-only GPUbnb Stage 4 dedicated-console inventory.
# NEVER installs, starts or signs the helper, touches the certificate store,
# changes user sessions, invokes NVIDIA workloads or modifies quarantine.
# This is inventory only, NOT the physical 300-second qualification.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExpectedGpuUuid,

    [string]$RenterAccount = 'gpubnb-renter-qual',

    [string]$HelperPath = "$env:ProgramFiles\GPUbnb\gpubnb-windows-stream.exe",

    # Both hashes must come from a separately reviewed, approved release
    # manifest. Empty values cannot produce a positive provenance gate.
    [string]$ExpectedHelperSha256 = '',
    [string]$ExpectedPublisherSha256 = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$checks = [System.Collections.Generic.List[object]]::new()
function Add-Check {
    param([string]$Name, [bool]$Passed, [string]$Reason)
    $checks.Add([pscustomobject]@{
        name = $Name
        passed = $Passed
        reason = $Reason
    })
}

if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
    Add-Check 'windows-x64' $false 'Windows x64 is required'
} else {
    Add-Check 'windows-x64' $true 'Running on Windows x64'
}

try {
    $os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $isWin11 = [int]$os.CurrentBuildNumber -ge 22000
    Add-Check 'windows-11' $isWin11 $(if ($isWin11) { 'Windows 11 build family' } else { 'Windows 11 required' })
    # Home/Core is allowed, no RDP host or Hyper-V role is assumed.
    $edition = [string]$os.EditionID
    Add-Check 'supported-edition' ($edition -in @('Core', 'CoreSingleLanguage', 'Professional', 'Enterprise', 'Education')) 'Native local-console route; edition never authorizes RDP'
} catch {
    Add-Check 'windows-version' $false 'Windows version could not be verified'
}

try {
    $secureBoot = [bool](Confirm-SecureBootUEFI -ErrorAction Stop)
    Add-Check 'secure-boot' $secureBoot $(if ($secureBoot) { 'Enabled' } else { 'Disabled: do not proceed' })
} catch {
    Add-Check 'secure-boot' $false 'Secure Boot state could not be verified'
}

if ($RenterAccount -notmatch '^[A-Za-z0-9._-]{1,64}$') {
    Add-Check 'renter-account' $false 'Invalid local renter account identifier'
} else {
    try {
        $renter = Get-LocalUser -Name $RenterAccount -ErrorAction Stop
        $adminSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
        $administrators = @(Get-LocalGroupMember -SID $adminSid -ErrorAction Stop)
        $isAdministrator = @($administrators | Where-Object {
            $null -ne $_.SID -and $_.SID.Value -eq $renter.SID.Value
        }).Count -ne 0
        $isStandard = $renter.Enabled -and -not $isAdministrator
        Add-Check 'renter-standard-user' $isStandard $(if ($isStandard) {
            'Enabled distinct local user with no direct Administrators membership'
        } else {
            'Account disabled, missing or directly in Administrators'
        })
    } catch {
        Add-Check 'renter-standard-user' $false 'Renter identity or local administrators group unavailable'
    }
}

if ($ExpectedGpuUuid -notmatch '^GPU-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$') {
    Add-Check 'gpu-uuid-format' $false 'Expected NVIDIA GPU UUID is not canonical'
} else {
    try {
        # Read-only NVIDIA inventory. Never chooses a different GPU implicitly.
        $nvidiaSmi = Get-Command 'nvidia-smi.exe' -ErrorAction Stop
        $uuids = @(& $nvidiaSmi.Source '--query-gpu=uuid' '--format=csv,noheader' 2>$null)
        $gpuMatches = @($uuids | Where-Object { ([string]$_).Trim() -ieq $ExpectedGpuUuid })
        $ok = $LASTEXITCODE -eq 0 -and $gpuMatches.Count -eq 1
        Add-Check 'exact-nvidia-gpu' $ok $(if ($ok) { 'Exactly one matching NVIDIA UUID' } else { 'GPU unavailable, missing or ambiguous' })
    } catch {
        Add-Check 'exact-nvidia-gpu' $false 'NVIDIA inventory unavailable'
    }
}

try {
    # A WMI monitor is an inventory hint, NOT proof it is a trusted physical
    # output, active console monitor or the source of GPUbnb capture.
    $activeMonitors = @(Get-CimInstance -Namespace 'root\wmi' -ClassName 'WmiMonitorID' -ErrorAction Stop |
        Where-Object { $_.Active -eq $true })
    Add-Check 'single-display-candidate' ($activeMonitors.Count -eq 1) $(if ($activeMonitors.Count -eq 1) {
        'One active monitor candidate; native signed capture must prove physical topology'
    } else {
        'No unique active monitor candidate'
    })
} catch {
    Add-Check 'single-display-candidate' $false 'Monitor inventory unavailable'
}

if ($ExpectedHelperSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or
    $ExpectedPublisherSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    Add-Check 'release-provenance' $false 'Approved exact helper SHA256 and publisher SHA256 are both required'
} elseif (-not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) {
    Add-Check 'release-provenance' $false 'Approved installed helper unavailable (no installation attempted)'
} else {
    try {
        $helper = (Resolve-Path -LiteralPath $HelperPath -ErrorAction Stop).Path
        $hash = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash
        $sig = Get-AuthenticodeSignature -LiteralPath $helper
        $signer = $sig.SignerCertificate
        $sigHash = if ($null -ne $signer) {
            $signer.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)
        } else {
            ''
        }
        $ok = $hash -ieq $ExpectedHelperSha256 -and
            $sig.Status -eq 'Valid' -and $sigHash -ieq $ExpectedPublisherSha256
        Add-Check 'release-provenance' $ok $(if ($ok) {
            'Exact binary hash and approved Authenticode signer verified'
        } else {
            'Hash, signature status or expected publisher differs'
        })
    } catch {
        Add-Check 'release-provenance' $false 'Could not validate helper provenance'
    }
}

$passed = @($checks | Where-Object { -not $_.passed }).Count -eq 0
[pscustomobject]@{
    schemaVersion = 1
    kind = 'GPUBNB_STAGE4_CONSOLE_READONLY_INVENTORY'
    captureBackend = 'console-dedicated'
    inventoryPassed = $passed
    localConsoleSessionProven = $false
    activeRenterSidProven = $false
    virtualDisplay = $false
    nvencPhysicallyVerified = $false
    browser300SecondsVerified = $false
    renterInputEffectsVerified = $false
    sourceRevocationPhysicallyVerified = $false
    completePackageVerified = $false
    physicalQualificationPassed = $false
    publicBookabilityAllowed = $false
    installationPerformed = $false
    certificateStoreModified = $false
    checks = $checks.ToArray()
} | ConvertTo-Json -Depth 7
# Read-only script always returns evidence; missing checks are not successes.
