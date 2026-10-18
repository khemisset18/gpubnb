#Requires -Version 5.1
# Builds only in an isolated Windows checkout. No signing, install or hardware session.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ExpectedCommit,
    [Parameter(Mandatory=$true)][string]$PublisherSha256,
    [Parameter(Mandatory=$true)][string]$NvCodecHeadersDir,
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) { throw 'stage4_windows_x64_required' }
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
function Check-Exit([string]$Step) { if($LASTEXITCODE -ne 0){throw "stage4_build_failed:$Step`:$LASTEXITCODE"} }
$head=(& git -C $repo rev-parse HEAD | Out-String).Trim();Check-Exit 'git-head'
if($ExpectedCommit -cnotmatch '^[0-9a-f]{40}$' -or $head -cne $ExpectedCommit){throw 'stage4_build_commit_mismatch'}
if($PublisherSha256 -cnotmatch '^[0-9a-f]{64}$' -or $PublisherSha256 -match '^(.)\1{63}$'){throw 'stage4_real_publisher_pin_required'}
& git -C $repo diff --quiet;Check-Exit 'tracked-worktree-clean'
& git -C $repo diff --cached --quiet;Check-Exit 'index-clean'
. (Join-Path $PSScriptRoot 'stage4-package-common.ps1')
$output=Assert-Stage4NewOutput $OutputDirectory $repo
$headers=(Resolve-Path -LiteralPath $NvCodecHeadersDir).Path
$headersRoot=(Resolve-Path (Join-Path $headers '..\..')).Path
$headersCommit=(& git -C $headersRoot rev-parse HEAD | Out-String).Trim();Check-Exit 'headers-commit'
if($headersCommit -cne 'e844e5b26f46bb77479f063029595293aa8f812d'){throw 'stage4_nvcodec_commit_mismatch'}
& git -C $headersRoot diff --quiet;Check-Exit 'headers-clean'
$header=Get-Content -LiteralPath (Join-Path $headers 'nvEncodeAPI.h') -Raw
if($header -notmatch '#define\s+NVENCAPI_MAJOR_VERSION\s+13' -or $header -notmatch '#define\s+NVENCAPI_MINOR_VERSION\s+0'){throw 'stage4_nvenc_api_mismatch'}
$work=Join-Path ([IO.Path]::GetTempPath()) ('stage4-build-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($work)
[void][IO.Directory]::CreateDirectory($output)
$oldPythonPath=$env:PYTHONPATH;$oldSource=$env:GPUBNB_SOURCE_COMMIT
$oldMedia=$env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256;$oldWorker=$env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256
try {
    # Copy only tracked Agent sources, then generate build provenance in this copy.
    $agentRoot=Join-Path $work 'agent'
    $tracked=@(& git -C $repo ls-files agent);Check-Exit 'tracked-agent-sources'
    foreach($relative in $tracked){
        $destination=Join-Path $work $relative
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
        Copy-Item -LiteralPath (Join-Path $repo $relative) -Destination $destination
    }
    $info=Join-Path $agentRoot 'gpubnb_agent\_build_info.py'
    $source=Get-Content -LiteralPath $info -Raw
    $source=[regex]::Replace($source,'BUILD_COMMIT = "[^"]+"',('BUILD_COMMIT = "'+$head.Substring(0,12)+'"'))
    [IO.File]::WriteAllText($info,$source,[Text.UTF8Encoding]::new($false))
    $env:PYTHONPATH=$agentRoot
    & python -m PyInstaller --clean --noconfirm --onefile --name gpubnb-agent `
        --paths $agentRoot --distpath $output --workpath (Join-Path $work 'pyinstaller') --specpath $work `
        --hidden-import=_cffi_backend --hidden-import=encodings.idna --hidden-import=servicemanager `
        --hidden-import=win32event --hidden-import=win32service --hidden-import=win32serviceutil `
        --hidden-import=win32timezone --collect-all cffi --collect-all nacl (Join-Path $agentRoot 'gpubnb_agent\__main__.py')
    Check-Exit 'frozen-agent'

    # Media -> worker -> release-candidate helper. The pin is the supplied REAL
    # public certificate fingerprint; no certificate or private key is used here.
    $msbuild=(Get-Command msbuild.exe -ErrorAction Stop).Source
    & $msbuild (Join-Path $repo 'native\windows-media\GPUbnbWindowsMedia.vcxproj') /m /t:Rebuild `
        /p:Configuration=Release /p:Platform=x64 "/p:NvCodecHeadersDir=$headers" "/p:SourceCommit=$head" /p:RunCodeAnalysis=true
    Check-Exit 'media-dll'
    Copy-Item -LiteralPath (Join-Path $repo 'native\windows-media\bin\Release\GPUbnbWindowsMedia.dll') -Destination $output
    $env:GPUBNB_SOURCE_COMMIT=$head
    $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256=$PublisherSha256
    $env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256=$PublisherSha256
    & cargo build --locked --release --manifest-path (Join-Path $repo 'native\windows-worker\Cargo.toml') --bin gpubnb-windows-worker
    Check-Exit 'worker'
    Copy-Item -LiteralPath (Join-Path $repo 'native\windows-worker\target\release\gpubnb-windows-worker.exe') -Destination $output
    & cargo build --locked --release --manifest-path (Join-Path $repo 'native\windows-stream-helper\Cargo.toml') --features release-candidate --bin gpubnb-windows-stream
    Check-Exit 'helper'
    Copy-Item -LiteralPath (Join-Path $repo 'native\windows-stream-helper\target\release\gpubnb-windows-stream.exe') -Destination $output

    $agent=(& (Join-Path $output 'gpubnb-agent.exe') build-info | Out-String) | ConvertFrom-Json;Check-Exit 'agent-build-info'
    $agentRuntime=(& (Join-Path $output 'gpubnb-agent.exe') runtime-check | Out-String) | ConvertFrom-Json;Check-Exit 'frozen-agent-runtime-check'
    $helper=(& (Join-Path $output 'gpubnb-windows-stream.exe') --build-policy --json | Out-String) | ConvertFrom-Json;Check-Exit 'helper-build-policy'
    $worker=(& (Join-Path $output 'gpubnb-windows-worker.exe') --build-policy --json | Out-String) | ConvertFrom-Json;Check-Exit 'worker-build-policy'
    # ctypes calls ONLY the pure DLL build identity export, never a media probe.
    $mediaCode='import ctypes,json,sys; d=ctypes.CDLL(sys.argv[1]); f=d.GPUbnbMediaBuildIdentity; f.restype=ctypes.c_char_p; print(f().decode("ascii"))'
    $media=(& python -c $mediaCode (Join-Path $output 'GPUbnbWindowsMedia.dll') | Out-String) | ConvertFrom-Json;Check-Exit 'media-build-identity'
    $identities=[ordered]@{agent=$agent;agentRuntime=$agentRuntime;helper=$helper;worker=$worker;media=$media}
    [IO.File]::WriteAllText((Join-Path $output 'build-identities.json'),($identities|ConvertTo-Json -Depth 10)+"`n",[Text.UTF8Encoding]::new($false))
    $proof=(& python (Join-Path $PSScriptRoot 'verify_stage4_package.py') create --directory $output --commit $head --publisher $PublisherSha256 | Out-String) | ConvertFrom-Json
    Check-Exit 'manifest-create-and-independent-pe-verification'
    & (Join-Path $PSScriptRoot 'verify-stage4-package.ps1') -PackageDirectory $output -ExpectedManifestSha256 $proof.manifestSha256 -ExpectedCommit $head -ExpectedPublisherSha256 $PublisherSha256 -ExecuteBuildIdentity
    if(-not $?){throw 'stage4_windows_package_verification_failed'}
    # Record the actual toolchain and dependency inventory, excluding environment values.
    $inventory=@('sourceCommit='+$head,'nvCodecHeadersCommit='+$headersCommit,'runnerImage='+$env:ImageVersion)
    $inventory+=(& python --version | Out-String).Trim()
    $inventory+=(& cargo --version | Out-String).Trim()
    $inventory+=(& rustc -vV | Out-String).Trim()
    $inventory+=(& python -m pip freeze | Out-String).Trim()
    [IO.File]::WriteAllText((Join-Path $output 'build-environment.txt'),($inventory -join "`n")+"`n",[Text.UTF8Encoding]::new($false))
    $support=Join-Path $output 'support';[void][IO.Directory]::CreateDirectory($support)
    foreach($name in @('stage4-package-common.ps1','verify-stage4-package.ps1','verify_stage4_package.py','stage4-private-test-sign-copies.ps1','stage4-test-ready-audit.ps1','stage4-pc1-inventory.ps1','qualification-preflight-pc-a.ps1','qualification-preflight-pc-b.ps1','stage4-windows-python.lock')){
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $support
    }
    Copy-Item -LiteralPath (Join-Path $repo 'docs\operations\stage4-test-ready') -Destination (Join-Path $output 'instructions') -Recurse
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'stage4-backup-installed.ps1') -Destination $support
    $proof | ConvertTo-Json -Depth 5
} finally {
    $env:PYTHONPATH=$oldPythonPath;$env:GPUBNB_SOURCE_COMMIT=$oldSource
    $env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256=$oldMedia;$env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256=$oldWorker
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
