#Requires -Version 5.1
# CI-only bundle smoke helper. This intentionally refuses every signed/release
# payload; it is not an installation path for PC1 or for a user download.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('CheckNoActiveNative','PreflightInstall','PreflightRemove')]
    [string]$Mode,
    [string]$PackageDirectory,
    [string]$ApplicationDirectory,
    [string]$NativeInstallDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Sha256Hex([string]$Path) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try {
            return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
        } finally {
            $stream.Dispose()
        }
    } finally {
        $algorithm.Dispose()
    }
}

$nativeNames = @(
    'gpubnb-windows-stream.exe',
    'gpubnb-windows-worker.exe',
    'GPUbnbWindowsMedia.dll'
)
$manifestNames = @(
    'gpubnb-agent.exe',
    'gpubnb-windows-stream.exe',
    'gpubnb-windows-worker.exe',
    'GPUbnbWindowsMedia.dll'
)

function Get-CanonicalDirectory([string]$Path, [string]$ErrorCode) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw $ErrorCode }
    $full = [IO.Path]::GetFullPath($Path)
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw $ErrorCode
        }
    }
    return $full.TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
}

function Assert-NoActiveNativeProcesses {
    $root = Get-CanonicalDirectory ([IO.Path]::Combine(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles), 'GPUbnb')) `
        'host_native_install_directory_invalid'
    foreach ($name in $nativeNames) {
        $expected = [IO.Path]::GetFullPath((Join-Path $root $name))
        $processes = @(Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction Stop)
        foreach ($process in $processes) {
            $actual = [string]$process.ExecutablePath
            if ([string]::IsNullOrWhiteSpace($actual)) {
                throw "host_native_process_path_unavailable:$name"
            }
            if ([string]::Equals([IO.Path]::GetFullPath($actual), $expected,
                    [StringComparison]::OrdinalIgnoreCase)) {
                throw "host_native_component_active:$name"
            }
        }
    }
}

function Assert-ProtectedInstallDirectory([string]$Path) {
    $unsafeSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
    $writeRights = [int]([Security.AccessControl.FileSystemRights]::Write -bor
        [Security.AccessControl.FileSystemRights]::Modify -bor
        [Security.AccessControl.FileSystemRights]::FullControl -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership)
    foreach ($rule in (Get-Acl -LiteralPath $Path -ErrorAction Stop).Access) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        try {
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        } catch {
            throw 'host_native_install_acl_identity_unresolvable'
        }
        if ($sid -in $unsafeSids -and (([int]$rule.FileSystemRights -band $writeRights) -ne 0)) {
            throw 'host_native_install_acl_broad_write_forbidden'
        }
    }
}

function Read-PreflightPackage {
    $package = Get-CanonicalDirectory $PackageDirectory 'host_native_package_directory_invalid'
    $allowed = @($nativeNames + 'build-identities.json' + 'stage4.manifest.json')
    foreach ($item in @(Get-ChildItem -LiteralPath $package -Force -Recurse -ErrorAction Stop)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            $item.PSIsContainer -or $item.Name -cnotin $allowed) {
            throw 'host_native_preflight_payload_shape_invalid'
        }
    }
    $manifestPath = Join-Path $package 'stage4.manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'host_native_preflight_manifest_missing'
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 2 -or
        $manifest.kind -cne 'STAGE4_UNSIGNED_PRIVATE_CANDIDATE' -or
        $manifest.signatureStatus -cne 'unsigned' -or
        $manifest.installable -cne $false -or
        $manifest.iddDriverIncluded -cne $false -or
        $manifest.publicBookabilityEnabled -cne $false -or
        $manifest.sourceCommit -cnotmatch '^[0-9a-f]{40}$' -or
        @($manifest.files).Count -ne 4) {
        throw 'host_native_preflight_release_or_installable_payload_rejected'
    }
    $identityPath = Join-Path $package 'build-identities.json'
    if (-not (Test-Path -LiteralPath $identityPath -PathType Leaf) -or
        (Get-Sha256Hex $identityPath) -cne
            $manifest.buildIdentitiesSha256) {
        throw 'host_native_preflight_build_identity_mismatch'
    }
    $records = @{}
    foreach ($name in $manifestNames) {
        $record = @($manifest.files | Where-Object { $_.name -ceq $name })
        if ($record.Count -ne 1 -or $record[0].architecture -cne 'AMD64') {
            throw "host_native_preflight_component_manifest_invalid:$name"
        }
        if ($name -cne 'gpubnb-agent.exe') {
            $path = Join-Path $package $name
            if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
                (Get-Sha256Hex $path) -cne
                    $record[0].sha256) {
                throw "host_native_preflight_component_hash_mismatch:$name"
            }
            $signature = Get-AuthenticodeSignature -LiteralPath $path
            if ($signature.Status -ne 'NotSigned' -or $null -ne $signature.SignerCertificate) {
                throw "host_native_preflight_signed_component_rejected:$name"
            }
        }
        $records[$name] = $record[0]
    }
    return [pscustomobject]@{Root=$package;Manifest=$manifest;Records=$records}
}

switch ($Mode) {
    'CheckNoActiveNative' {
        Assert-NoActiveNativeProcesses
        [ordered]@{ok=$true;mode=$Mode;nativeProcessesActive=$false} | ConvertTo-Json -Compress
        break
    }
    'PreflightInstall' {
        if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
            throw 'host_native_preflight_ci_runner_required'
        }
        $bundle = Read-PreflightPackage
        $app = Get-CanonicalDirectory $ApplicationDirectory 'host_native_application_directory_invalid'
        $sidecar = Join-Path $app 'gpubnb-agent.exe'
        if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf) -or
            (Get-Sha256Hex $sidecar) -cne
                $bundle.Records['gpubnb-agent.exe'].sha256) {
            throw 'host_native_preflight_agent_mismatch'
        }
        $agentSignature = Get-AuthenticodeSignature -LiteralPath $sidecar
        if ($agentSignature.Status -ne 'NotSigned' -or $null -ne $agentSignature.SignerCertificate) {
            throw 'host_native_preflight_signed_component_rejected:gpubnb-agent.exe'
        }
        Assert-NoActiveNativeProcesses
        $destination = Get-CanonicalDirectory $NativeInstallDirectory 'host_native_install_directory_invalid'
        $parent = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw 'host_native_install_parent_missing'
        }
        [void][IO.Directory]::CreateDirectory($destination)
        $destinationItem = Get-Item -LiteralPath $destination -Force
        if (($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'host_native_install_directory_invalid'
        }
        Assert-ProtectedInstallDirectory $destination
        foreach ($name in $nativeNames) {
            $target = Join-Path $destination $name
            if (Test-Path -LiteralPath $target -PathType Leaf) {
                $actual = (Get-Sha256Hex $target)
                if ($actual -cne $bundle.Records[$name].sha256) {
                    throw "host_native_preflight_update_requires_reviewed_rollback:$name"
                }
            }
        }
        $staging = Join-Path $destination ('.gpubnb-staging-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($staging)
        $created = [Collections.Generic.List[string]]::new()
        try {
            foreach ($name in $nativeNames) {
                $target = Join-Path $destination $name
                if (Test-Path -LiteralPath $target -PathType Leaf) { continue }
                $staged = Join-Path $staging $name
                Copy-Item -LiteralPath (Join-Path $bundle.Root $name) -Destination $staged
                if ((Get-Sha256Hex $staged) -cne
                    $bundle.Records[$name].sha256) {
                    throw "host_native_preflight_staged_hash_mismatch:$name"
                }
            }
            foreach ($name in $nativeNames) {
                $target = Join-Path $destination $name
                if (Test-Path -LiteralPath $target -PathType Leaf) { continue }
                [IO.File]::Move((Join-Path $staging $name), $target)
                $created.Add($target)
            }
        } catch {
            foreach ($path in $created) {
                if (Test-Path -LiteralPath $path -PathType Leaf) {
                    $name = [IO.Path]::GetFileName($path)
                    if ((Get-Sha256Hex $path) -ceq
                        $bundle.Records[$name].sha256) {
                        Remove-Item -LiteralPath $path -Force
                    }
                }
            }
            throw
        } finally {
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        }
        [ordered]@{ok=$true;mode=$Mode;filesInstalled=$nativeNames.Count
            installable=$false;iddDriverIncluded=$false;publicBookabilityEnabled=$false} |
            ConvertTo-Json -Compress
        break
    }
    'PreflightRemove' {
        if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
            throw 'host_native_preflight_ci_runner_required'
        }
        $bundle = Read-PreflightPackage
        Assert-NoActiveNativeProcesses
        $destination = Get-CanonicalDirectory $NativeInstallDirectory 'host_native_install_directory_invalid'
        if (Test-Path -LiteralPath $destination -PathType Container) {
            Assert-ProtectedInstallDirectory $destination
        }
        foreach ($name in $nativeNames) {
            $target = Join-Path $destination $name
            if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { continue }
            if ((Get-Sha256Hex $target) -cne
                $bundle.Records[$name].sha256) {
                throw "host_native_preflight_remove_hash_mismatch:$name"
            }
        }
        foreach ($name in $nativeNames) {
            $target = Join-Path $destination $name
            if (Test-Path -LiteralPath $target -PathType Leaf) {
                Remove-Item -LiteralPath $target -Force
            }
        }
        [ordered]@{ok=$true;mode=$Mode;filesRemoved=$nativeNames.Count} | ConvertTo-Json -Compress
        break
    }
}
