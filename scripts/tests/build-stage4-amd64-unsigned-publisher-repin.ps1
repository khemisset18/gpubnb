# Test-only non-signing publisher repin rehearsal. Not an approved signing authority.
# Non-signing CI measurement only. Never an installer or a release approval.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)][string]$NvCodecHeadersDir,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [Parameter(Mandatory=$true)][string]$SourceCommit,
    [Parameter(Mandatory=$true)][string]$WorkflowCommit,
    [Parameter(Mandatory=$true)][string]$PublisherCertificateSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($SourceCommit -cne '2b055992f7521505d0387dd4c876e36794fffd63') { throw 'unexpected_source_commit' }
if ($WorkflowCommit -notmatch '^[0-9a-f]{40}$') { throw 'invalid_workflow_commit' }
if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess) { throw 'windows_amd64_required' }
foreach ($name in @('GPUBNB_CODESIGN_THUMBPRINT','GPUBNB_CODESIGN_PFX_BASE64','GPUBNB_CODESIGN_PFX_PASSWORD')) {
    if (Test-Path "Env:$name") { throw 'signing_environment_forbidden' }
}
$root=(Resolve-Path -LiteralPath $SourceRoot).Path
$headers=(Resolve-Path -LiteralPath $NvCodecHeadersDir).Path
$output=[IO.Path]::GetFullPath($OutputDirectory)
[void][IO.Directory]::CreateDirectory($output)
function Assert-Native([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "build_failed:$Step" } }
function Capture-Native([string]$Step,[scriptblock]$Command) {
    $value=(& $Command | Out-String).Trim()
    Assert-Native $Step
    return $value
}
$actual=Capture-Native 'source identity' { git -C $root rev-parse HEAD }
if ($actual -cne $SourceCommit) { throw 'source_commit_mismatch' }
& git -C $root diff --quiet
Assert-Native 'clean source'
& git -C $root diff --cached --quiet
Assert-Native 'clean index'
if ($PublisherCertificateSha256 -cnotmatch '^[0-9a-f]{64}
$header=Join-Path $headers 'nvEncodeAPI.h'
$headerText=Get-Content -LiteralPath $header -Raw
if ($headerText -notmatch '#define\s+NVENCAPI_MAJOR_VERSION\s+13' -or
    $headerText -notmatch '#define\s+NVENCAPI_MINOR_VERSION\s+0') { throw 'nvenc_13_0_required' }
$env:GPUBNB_SOURCE_COMMIT=$SourceCommit
$env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256=$pin
$env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256=$pin
$toolchain=[ordered]@{
    rustc=(Capture-Native 'rustc version' { rustc -vV })
    cargo=(Capture-Native 'cargo version' { cargo -V })
    python=(Capture-Native 'python version' { python --version })
    msbuild=(Capture-Native 'MSBuild version' { msbuild -version -nologo })
}
if ($toolchain.rustc -notmatch 'host: x86_64-pc-windows-msvc') { throw 'rust_host_not_amd64' }

Push-Location $root
try {
    # Same authority as the existing private qualification artifact, never production.
    & cargo build --locked --release --manifest-path native/windows-stream-helper/Cargo.toml --features physical-qualification --bin gpubnb-windows-stream
    Assert-Native 'private helper build'
    Copy-Item native/windows-stream-helper/target/release/gpubnb-windows-stream.exe (Join-Path $output 'gpubnb-windows-stream.exe')
    & cargo build --locked --release --manifest-path native/windows-worker/Cargo.toml --bin gpubnb-windows-worker
    Assert-Native 'worker build'
    Copy-Item native/windows-worker/target/release/gpubnb-windows-worker.exe (Join-Path $output 'gpubnb-windows-worker.exe')
    # This explicit branch returns before parsing runtime commands or initializing capture.
    $workerPolicyRaw=Capture-Native 'worker metadata' { & (Join-Path $output 'gpubnb-windows-worker.exe') --build-policy --json }
    $workerPolicy=$workerPolicyRaw | ConvertFrom-Json
    if ($workerPolicy.schemaVersion -ne 1 -or $workerPolicy.sourceCommit -cne $SourceCommit -or
        $workerPolicy.mediaSignerSha256 -cne $pin) { throw 'worker_policy_mismatch' }
    [IO.File]::WriteAllText((Join-Path $output 'worker-build-policy.json'),$workerPolicyRaw+[char]10,[Text.UTF8Encoding]::new($false))
    $helperPath=Join-Path $output 'gpubnb-windows-stream.exe'
    $helperAscii=[Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($helperPath))
    if (-not $helperAscii.Contains($pin)) { throw 'helper_compiled_worker_pin_missing' }
    & msbuild native/windows-media/GPUbnbWindowsMedia.vcxproj /m /p:Configuration=Release /p:Platform=x64 "/p:NvCodecHeadersDir=$headers" /p:RunCodeAnalysis=true
    Assert-Native 'media DLL build'
    Copy-Item native/windows-media/bin/Release/GPUbnbWindowsMedia.dll (Join-Path $output 'GPUbnbWindowsMedia.dll')

    # Standard generated PyInstaller provenance overlay, not an application-code change.
    $buildInfoPath=Join-Path $root 'agent/gpubnb_agent/_build_info.py'
    $overlayBefore=(Get-FileHash -LiteralPath $buildInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $info=Get-Content -LiteralPath $buildInfoPath -Raw
    $short=$SourceCommit.Substring(0,12)
    $updated=[regex]::Replace($info,'BUILD_COMMIT = "[^"]+"',('BUILD_COMMIT = "'+$short+'"'))
    if ($info -ceq $updated) { throw 'agent_stamp_failed' }
    [IO.File]::WriteAllText($buildInfoPath,$updated,[Text.UTF8Encoding]::new($false))
    $overlayAfter=(Get-FileHash -LiteralPath $buildInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()
    & python -m pip install ./agent pyinstaller==6.16.0
    Assert-Native 'Agent build dependencies'
    & pyinstaller --clean --noconfirm --onefile --name gpubnb-agent --hidden-import=_cffi_backend --hidden-import=encodings.idna --hidden-import=servicemanager --hidden-import=win32event --hidden-import=win32service --hidden-import=win32serviceutil --hidden-import=win32timezone --hidden-import=urllib.request --collect-all cffi --collect-all nacl agent/gpubnb_agent/__main__.py
    Assert-Native 'Agent PyInstaller build'
    Copy-Item dist/gpubnb-agent.exe (Join-Path $output 'gpubnb-agent.exe')
    $agentInfoRaw=Capture-Native 'Agent public build metadata' { & (Join-Path $output 'gpubnb-agent.exe') build-info }
    $agentInfo=$agentInfoRaw | ConvertFrom-Json
    if ($agentInfo.buildCommit -cne $short -or -not $agentInfo.frozen -or $agentInfo.agentVersion -cne '0.6.6') { throw 'agent_build_identity_mismatch' }
    [IO.File]::WriteAllText((Join-Path $output 'agent-build-info.json'),$agentInfoRaw+[char]10,[Text.UTF8Encoding]::new($false))
    & python -m pip freeze | Set-Content (Join-Path $output 'python-build-dependencies.txt') -Encoding utf8
    Assert-Native 'build dependency inventory'
} finally { Pop-Location }

# Inspect only PE bytes; no helper launch, media DLL loading or session operations.
$records=@()
foreach ($name in @('gpubnb-windows-stream.exe','gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll','gpubnb-agent.exe')) {
    $path=Join-Path $output $name
    $bytes=[IO.File]::ReadAllBytes($path)
    if ($bytes.Length -lt 256 -or [BitConverter]::ToUInt16($bytes,0) -ne 0x5a4d) { throw "invalid_pe:$name" }
    $pe=[BitConverter]::ToInt32($bytes,0x3c)
    if ($pe -lt 0 -or $pe+264 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes,$pe) -ne 0x4550) { throw "invalid_pe_header:$name" }
    $machine=[BitConverter]::ToUInt16($bytes,$pe+4)
    $magic=[BitConverter]::ToUInt16($bytes,$pe+24)
    $certificateSize=[BitConverter]::ToUInt32($bytes,$pe+24+112+4*8+4)
    if ($machine -ne 0x8664 -or $magic -ne 0x20b -or $certificateSize -ne 0) { throw "unsigned_amd64_required:$name" }
    $signature=Get-AuthenticodeSignature -LiteralPath $path
    if ($null -ne $signature.SignerCertificate -or [string]$signature.Status -cne 'NotSigned') { throw "unexpected_signature:$name" }
    $file=Get-Item -LiteralPath $path
    $version=if ($name -eq 'gpubnb-agent.exe') { '0.6.6' } elseif ($name -eq 'GPUbnbWindowsMedia.dll') { 'media-ABI-2' } else { '0.1.0' }
    $records += [ordered]@{name=$name;sourceCommit=$SourceCommit;version=$version;
        sizeBytes=$file.Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();
        architecture='AMD64';peMachine='0x8664';peMagic='0x20b';certificateTableSize=$certificateSize;
        embeddedFileVersion=$file.VersionInfo.FileVersion;embeddedProductVersion=$file.VersionInfo.ProductVersion;
        authenticodeStatus=[string]$signature.Status;signed=$false;installable=$false}
}
$manifest=[ordered]@{
    schemaVersion=1;sourceCommit=$SourceCommit;workflowCommit=$WorkflowCommit;
    repository='khemisset18/gpubnb';workflowPath='.github/workflows/stage4-publisher-pin-rehearsal.yml';
    runId=$env:GITHUB_RUN_ID;runAttempt=$env:GITHUB_RUN_ATTEMPT;jobKey=$env:GITHUB_JOB;
    generatedAtUtc=[DateTime]::UtcNow.ToString('o');mutationAuthority='physical-qualification';
    signingPerformed=$false;installationAuthorized=$false;publicBookabilityEnabled=$false;
    workerSignerSha256=$pin;mediaSignerSha256=$pin;publisherIdentityApproval='not_granted_by_this_build';
    signatureAuthority='none';publisherPinSource='explicit_public_input_only';
    readiness='synthetic_unsigned_rehearsal_not_installable';
    workerProtocolVersion=1;browserMediaProtocolVersion=1;browserInputProtocolVersion=1;mediaAbiVersion=2;
    nvencApi='13.0';nvCodecHeadersCommit='e844e5b26f46bb77479f063029595293aa8f812d';
    nvEncodeHeaderSha256=(Get-FileHash -LiteralPath $header -Algorithm SHA256).Hash.ToLowerInvariant();
    agentBuildOverlay=@{path='agent/gpubnb_agent/_build_info.py';beforeSha256=$overlayBefore;afterSha256=$overlayAfter;buildCommit=$short};
    toolchain=$toolchain;files=$records
}
[IO.File]::WriteAllText((Join-Path $output 'ci-build-manifest.json'),($manifest|ConvertTo-Json -Depth 10)+[char]10,[Text.UTF8Encoding]::new($false))
$sumLines=@(Get-ChildItem -LiteralPath $output -File | Sort-Object Name | ForEach-Object {
    (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+$_.Name
})
[IO.File]::WriteAllLines((Join-Path $output 'SHA256SUMS'),$sumLines,[Text.UTF8Encoding]::new($false))
Write-Host ($manifest|ConvertTo-Json -Depth 10)
 -or $PublisherCertificateSha256 -ceq ('0' * 64)) { throw 'proposed_publisher_pin_invalid' }
$pin=$PublisherCertificateSha256
$header=Join-Path $headers 'nvEncodeAPI.h'
$headerText=Get-Content -LiteralPath $header -Raw
if ($headerText -notmatch '#define\s+NVENCAPI_MAJOR_VERSION\s+13' -or
    $headerText -notmatch '#define\s+NVENCAPI_MINOR_VERSION\s+0') { throw 'nvenc_13_0_required' }
$env:GPUBNB_SOURCE_COMMIT=$SourceCommit
$env:GPUBNB_WINDOWS_WORKER_SIGNER_SHA256=$pin
$env:GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256=$pin
$toolchain=[ordered]@{
    rustc=(Capture-Native 'rustc version' { rustc -vV })
    cargo=(Capture-Native 'cargo version' { cargo -V })
    python=(Capture-Native 'python version' { python --version })
    msbuild=(Capture-Native 'MSBuild version' { msbuild -version -nologo })
}
if ($toolchain.rustc -notmatch 'host: x86_64-pc-windows-msvc') { throw 'rust_host_not_amd64' }

Push-Location $root
try {
    # Same authority as the existing private qualification artifact, never production.
    & cargo build --locked --release --manifest-path native/windows-stream-helper/Cargo.toml --features physical-qualification --bin gpubnb-windows-stream
    Assert-Native 'private helper build'
    Copy-Item native/windows-stream-helper/target/release/gpubnb-windows-stream.exe (Join-Path $output 'gpubnb-windows-stream.exe')
    & cargo build --locked --release --manifest-path native/windows-worker/Cargo.toml --bin gpubnb-windows-worker
    Assert-Native 'worker build'
    Copy-Item native/windows-worker/target/release/gpubnb-windows-worker.exe (Join-Path $output 'gpubnb-windows-worker.exe')
    # This explicit branch returns before parsing runtime commands or initializing capture.
    $workerPolicyRaw=Capture-Native 'worker metadata' { & (Join-Path $output 'gpubnb-windows-worker.exe') --build-policy --json }
    $workerPolicy=$workerPolicyRaw | ConvertFrom-Json
    if ($workerPolicy.schemaVersion -ne 1 -or $workerPolicy.sourceCommit -cne $SourceCommit -or
        $workerPolicy.mediaSignerSha256 -cne $pin) { throw 'worker_policy_mismatch' }
    [IO.File]::WriteAllText((Join-Path $output 'worker-build-policy.json'),$workerPolicyRaw+[char]10,[Text.UTF8Encoding]::new($false))
    & msbuild native/windows-media/GPUbnbWindowsMedia.vcxproj /m /p:Configuration=Release /p:Platform=x64 "/p:NvCodecHeadersDir=$headers" /p:RunCodeAnalysis=true
    Assert-Native 'media DLL build'
    Copy-Item native/windows-media/bin/Release/GPUbnbWindowsMedia.dll (Join-Path $output 'GPUbnbWindowsMedia.dll')

    # Standard generated PyInstaller provenance overlay, not an application-code change.
    $buildInfoPath=Join-Path $root 'agent/gpubnb_agent/_build_info.py'
    $overlayBefore=(Get-FileHash -LiteralPath $buildInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $info=Get-Content -LiteralPath $buildInfoPath -Raw
    $short=$SourceCommit.Substring(0,12)
    $updated=[regex]::Replace($info,'BUILD_COMMIT = "[^"]+"',('BUILD_COMMIT = "'+$short+'"'))
    if ($info -ceq $updated) { throw 'agent_stamp_failed' }
    [IO.File]::WriteAllText($buildInfoPath,$updated,[Text.UTF8Encoding]::new($false))
    $overlayAfter=(Get-FileHash -LiteralPath $buildInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()
    & python -m pip install ./agent pyinstaller==6.16.0
    Assert-Native 'Agent build dependencies'
    & pyinstaller --clean --noconfirm --onefile --name gpubnb-agent --hidden-import=_cffi_backend --hidden-import=encodings.idna --hidden-import=servicemanager --hidden-import=win32event --hidden-import=win32service --hidden-import=win32serviceutil --hidden-import=win32timezone --hidden-import=urllib.request --collect-all cffi --collect-all nacl agent/gpubnb_agent/__main__.py
    Assert-Native 'Agent PyInstaller build'
    Copy-Item dist/gpubnb-agent.exe (Join-Path $output 'gpubnb-agent.exe')
    $agentInfoRaw=Capture-Native 'Agent public build metadata' { & (Join-Path $output 'gpubnb-agent.exe') build-info }
    $agentInfo=$agentInfoRaw | ConvertFrom-Json
    if ($agentInfo.buildCommit -cne $short -or -not $agentInfo.frozen -or $agentInfo.agentVersion -cne '0.6.6') { throw 'agent_build_identity_mismatch' }
    [IO.File]::WriteAllText((Join-Path $output 'agent-build-info.json'),$agentInfoRaw+[char]10,[Text.UTF8Encoding]::new($false))
    & python -m pip freeze | Set-Content (Join-Path $output 'python-build-dependencies.txt') -Encoding utf8
    Assert-Native 'build dependency inventory'
} finally { Pop-Location }

# Inspect only PE bytes; no helper launch, media DLL loading or session operations.
$records=@()
foreach ($name in @('gpubnb-windows-stream.exe','gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll','gpubnb-agent.exe')) {
    $path=Join-Path $output $name
    $bytes=[IO.File]::ReadAllBytes($path)
    if ($bytes.Length -lt 256 -or [BitConverter]::ToUInt16($bytes,0) -ne 0x5a4d) { throw "invalid_pe:$name" }
    $pe=[BitConverter]::ToInt32($bytes,0x3c)
    if ($pe -lt 0 -or $pe+264 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes,$pe) -ne 0x4550) { throw "invalid_pe_header:$name" }
    $machine=[BitConverter]::ToUInt16($bytes,$pe+4)
    $magic=[BitConverter]::ToUInt16($bytes,$pe+24)
    $certificateSize=[BitConverter]::ToUInt32($bytes,$pe+24+112+4*8+4)
    if ($machine -ne 0x8664 -or $magic -ne 0x20b -or $certificateSize -ne 0) { throw "unsigned_amd64_required:$name" }
    $signature=Get-AuthenticodeSignature -LiteralPath $path
    if ($null -ne $signature.SignerCertificate -or [string]$signature.Status -cne 'NotSigned') { throw "unexpected_signature:$name" }
    $file=Get-Item -LiteralPath $path
    $version=if ($name -eq 'gpubnb-agent.exe') { '0.6.6' } elseif ($name -eq 'GPUbnbWindowsMedia.dll') { 'media-ABI-2' } else { '0.1.0' }
    $records += [ordered]@{name=$name;sourceCommit=$SourceCommit;version=$version;
        sizeBytes=$file.Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();
        architecture='AMD64';peMachine='0x8664';peMagic='0x20b';certificateTableSize=$certificateSize;
        embeddedFileVersion=$file.VersionInfo.FileVersion;embeddedProductVersion=$file.VersionInfo.ProductVersion;
        authenticodeStatus=[string]$signature.Status;signed=$false;installable=$false}
}
$manifest=[ordered]@{
    schemaVersion=1;sourceCommit=$SourceCommit;workflowCommit=$WorkflowCommit;
    repository='khemisset18/gpubnb';workflowPath='.github/workflows/stage4-amd64-manifest.yml';
    runId=$env:GITHUB_RUN_ID;runAttempt=$env:GITHUB_RUN_ATTEMPT;jobKey=$env:GITHUB_JOB;
    generatedAtUtc=[DateTime]::UtcNow.ToString('o');mutationAuthority='physical-qualification';
    signingPerformed=$false;installationAuthorized=$false;publicBookabilityEnabled=$false;
    workerSignerSha256=$pin;mediaSignerSha256=$pin;publisherIdentityApproval='not_granted_by_this_build';
    workerProtocolVersion=1;browserMediaProtocolVersion=1;browserInputProtocolVersion=1;mediaAbiVersion=2;
    nvencApi='13.0';nvCodecHeadersCommit='e844e5b26f46bb77479f063029595293aa8f812d';
    nvEncodeHeaderSha256=(Get-FileHash -LiteralPath $header -Algorithm SHA256).Hash.ToLowerInvariant();
    agentBuildOverlay=@{path='agent/gpubnb_agent/_build_info.py';beforeSha256=$overlayBefore;afterSha256=$overlayAfter;buildCommit=$short};
    toolchain=$toolchain;files=$records
}
[IO.File]::WriteAllText((Join-Path $output 'ci-build-manifest.json'),($manifest|ConvertTo-Json -Depth 10)+[char]10,[Text.UTF8Encoding]::new($false))
$sumLines=@(Get-ChildItem -LiteralPath $output -File | Sort-Object Name | ForEach-Object {
    (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+$_.Name
})
[IO.File]::WriteAllLines((Join-Path $output 'SHA256SUMS'),$sumLines,[Text.UTF8Encoding]::new($false))
Write-Host ($manifest|ConvertTo-Json -Depth 10)
