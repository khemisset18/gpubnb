param([Parameter(Mandatory=$true)][string]$OutputDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -cne 'khemisset18/gpubnb' -or
    $env:GITHUB_REF_NAME -cne 'prep/stage4-osslsigncode-hardened-20261015') {
    throw 'hardened_build_requires_isolated_hosted_windows_branch'
}
function Get-RootStoreSnapshot {
    $rows=foreach($scope in @('CurrentUser','LocalMachine')){
        Get-ChildItem -LiteralPath "Cert:\$scope\Root" | ForEach-Object {
            "$scope|$($_.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256))"
        }
    }
    return @($rows|Sort-Object -Unique)
}
$rootsBeforeBuild=@(Get-RootStoreSnapshot)
$base=[IO.Path]::GetFullPath($env:RUNNER_TEMP)+[IO.Path]::DirectorySeparatorChar
$work=[IO.Path]::GetFullPath($OutputDirectory)
if (-not $work.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $work)) { throw 'build_destination_must_be_new_runner_temp_directory' }
[void](New-Item -ItemType Directory -Path $work)
"GPUBNB_HARDENED_BUILD_ROOT=$work" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
$lock=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'sources.lock.json') -Raw | ConvertFrom-Json
$patch=Join-Path $PSScriptRoot 'tls-fail-closed.patch'
if ((Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash.ToLowerInvariant() -cne $lock.patchSha256) { throw 'hardening_patch_hash_mismatch' }
$emptyGitConfig=Join-Path $work 'empty-git.config'
[IO.File]::WriteAllText($emptyGitConfig,'',[Text.Encoding]::ASCII)
$emptyHooks=Join-Path $work 'empty-hooks'
[void](New-Item -ItemType Directory -Path $emptyHooks)
$childEnv=@{
    SystemRoot=$env:SystemRoot;WINDIR=$env:WINDIR;TEMP=$work;TMP=$work
    PATH="$env:SystemRoot\System32;C:\Program Files\CMake\bin;C:\Program Files\Git\cmd;C:\Strawberry\perl\bin"
    GIT_CONFIG_NOSYSTEM='1';GIT_CONFIG_GLOBAL=$emptyGitConfig;GIT_TERMINAL_PROMPT='0'
}
function Run([string]$Exe,[string[]]$Arguments,[string]$Directory=$work,[int]$TimeoutMs=1200000) {
    # File redirection avoids waiting indefinitely for EOF held by an orphaned
    # compiler/test descendant after its parent has exited. Only fixed build
    # arguments are accepted; cmd metacharacters/expansion are rejected.
    $id=[Guid]::NewGuid().ToString('N')
    $outFile=Join-Path $work ($id+'.stdout.log')
    $errFile=Join-Path $work ($id+'.stderr.log')
    $batch=Join-Path $work ($id+'.cmd')
    $words=@($Exe)+$Arguments
    foreach($word in $words){if($word -match '[%\r\n"!^&<>|]'){throw 'build_argument_not_safe_for_fixed_batch'}}
    $line=(@($words|ForEach-Object {'"'+$_+'"'}) -join ' ')
    [IO.File]::WriteAllText($batch,('@echo off'+"`r`n"+$line+' 1>"'+$outFile+'" 2>"'+$errFile+'"'+"`r`n@exit /b %errorlevel%`r`n"),[Text.Encoding]::ASCII)
    Write-Host ("Build process: "+[IO.Path]::GetFileName($Exe)+' '+($Arguments -join ' '))
    $si=[Diagnostics.ProcessStartInfo]::new()
    $si.FileName="$env:SystemRoot\System32\cmd.exe";$si.WorkingDirectory=$Directory;$si.UseShellExecute=$false
    $si.Environment.Clear()
    foreach($k in $childEnv.Keys){$si.Environment[$k]=$childEnv[$k]}
    foreach($a in @('/d','/v:off','/c',$batch)){$si.ArgumentList.Add($a)}
    $p=[Diagnostics.Process]::new();$p.StartInfo=$si
    try {
        if(-not $p.Start()){throw 'build_process_start_failed'}
        $completed=$p.WaitForExit($TimeoutMs)
        if(-not $completed){$p.Kill($true);[void]$p.WaitForExit(10000)}
        $stdout=if(Test-Path -LiteralPath $outFile){[IO.File]::ReadAllText($outFile)}else{''}
        $stderr=if(Test-Path -LiteralPath $errFile){[IO.File]::ReadAllText($errFile)}else{''}
        if(-not $completed){
            Write-Host $stdout.Substring([Math]::Max(0,$stdout.Length-18000))
            Write-Host $stderr.Substring([Math]::Max(0,$stderr.Length-18000))
            throw "build_process_timeout:$([IO.Path]::GetFileName($Exe))"
        }
        if($p.ExitCode -ne 0){
            Write-Host $stdout.Substring([Math]::Max(0,$stdout.Length-18000))
            Write-Host $stderr.Substring([Math]::Max(0,$stderr.Length-18000))
            throw "build_process_failed:$([IO.Path]::GetFileName($Exe)):$($p.ExitCode)"
        }
        return ($stdout+$stderr).Trim()
    } finally {$p.Dispose()}
}
function Download([string]$Url,[string]$Destination,[string]$Sha256,[long]$Size) {
    $u=[Uri]$Url;$h=[Net.Http.HttpClientHandler]::new()
    $h.AllowAutoRedirect=$false;$h.UseDefaultCredentials=$false;$h.UseProxy=$false
    $client=[Net.Http.HttpClient]::new($h);$client.Timeout=[TimeSpan]::FromSeconds(90)
    try {
        for($i=0;$i -lt 6;$i++){
            if($u.Scheme -cne 'https' -or $u.UserInfo -ne '' -or
                $u.Host -notin @('github.com','release-assets.githubusercontent.com','objects.githubusercontent.com')){throw 'source_redirect_not_allowlisted_https'}
            $r=$client.GetAsync($u).GetAwaiter().GetResult()
            try {
                if([int]$r.StatusCode -in @(301,302,303,307,308)){
                    if($null -eq $r.Headers.Location){throw 'source_redirect_missing'}
                    $u=[Uri]::new($u,$r.Headers.Location);continue
                }
                if(-not $r.IsSuccessStatusCode){throw 'source_download_http_error'}
                $bytes=$r.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
                if($bytes.Length -ne $Size -or
                    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $Sha256){throw 'source_archive_size_or_hash_mismatch'}
                [IO.File]::WriteAllBytes($Destination,$bytes);return
            }finally{$r.Dispose()}
        }
        throw 'source_redirect_limit'
    }finally{$client.Dispose();$h.Dispose()}
}
function Extract([string]$Archive) {
    $names=Run "$env:SystemRoot\System32\tar.exe" @('-tzf',$Archive)
    foreach($n in ($names -split "`r?`n")){
        if([IO.Path]::IsPathRooted($n) -or $n -match '(^|[/\\])\.\.([/\\]|$)' -or $n -match ':'){throw 'source_archive_path_invalid'}
    }
    [void](Run "$env:SystemRoot\System32\tar.exe" @('-xzf',$Archive,'-C',$work))
}
$vc='C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat'
if(-not (Test-Path -LiteralPath $vc -PathType Leaf)){throw 'expected_visual_studio_toolchain_missing'}
# Only this temporary process receives vcvars. No system/user environment is changed.
$init=Join-Path $work 'init-msvc.cmd'
[IO.File]::WriteAllText($init,('@call "'+$vc+'" >nul'+"`r`n@set`r`n"),[Text.Encoding]::ASCII)
$vcOutput=Run "$env:SystemRoot\System32\cmd.exe" @('/d','/c','init-msvc.cmd')
foreach($line in ($vcOutput -split "`r?`n")){
    if($line -match '^([^=]+)=(.*)$' -and $Matches[1] -in @('PATH','INCLUDE','LIB','LIBPATH','VCToolsInstallDir','VCToolsVersion','WindowsSdkDir','WindowsSDKVersion','UniversalCRTSdkDir','UCRTVersion')){
        $childEnv[$Matches[1]]=$Matches[2]
    }
}
foreach($n in @('INCLUDE','LIB','VCToolsInstallDir')){if(-not $childEnv.ContainsKey($n)){throw 'msvc_environment_incomplete'}}
$compiler=Join-Path $childEnv['VCToolsInstallDir'] 'bin\Hostx64\x64\cl.exe'
$linker=Join-Path $childEnv['VCToolsInstallDir'] 'bin\Hostx64\x64\link.exe'
$nmake=Join-Path $childEnv['VCToolsInstallDir'] 'bin\Hostx64\x64\nmake.exe'
$perl='C:\Strawberry\perl\bin\perl.exe'
$cmake='C:\Program Files\CMake\bin\cmake.exe'
$ctest='C:\Program Files\CMake\bin\ctest.exe'
$git='C:\Program Files\Git\cmd\git.exe'
foreach($p in @($compiler,$linker,$nmake,$perl,$cmake,$ctest,$git)){
    if(-not (Test-Path -LiteralPath $p -PathType Leaf)){throw "build_tool_missing:$([IO.Path]::GetFileName($p))"}
}
$provenance=[ordered]@{
    schemaVersion=1;workflowCommit=$env:GITHUB_SHA;workflowRunId=$env:GITHUB_RUN_ID
    repository=$env:GITHUB_REPOSITORY;builtAtUtc=[DateTime]::UtcNow.ToString('o')
    windowsVersion=[Environment]::OSVersion.Version.ToString();architecture='AMD64'
    sources=$lock;gpuBnbPrivateKeyUsed=$false;gpuBnbBinarySigned=$false
    rootStoresModified=$false;machineConfigurationModified=$false
    compilerTools=@(@($compiler,$linker,$nmake,$perl,$cmake,$git) | ForEach-Object {
        $f=Get-Item -LiteralPath $_
        [ordered]@{name=$f.Name;path=$f.FullName;version=$f.VersionInfo.ProductVersion;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()}
    })
    compilerVersion=$childEnv['VCToolsVersion'];windowsSdkVersion=$childEnv['WindowsSDKVersion']
    upstreamPgpSignatureVerified=$false;reproducibleBuildProven=$false
    isolatedToolOnly=$true;extraCostEuros=0
}
foreach($package in @($lock.openssl,$lock.zlib)){
    $archive=Join-Path $work $package.archive
    Download $package.url $archive $package.sha256 $package.sizeBytes
    Extract $archive
}
$src=Join-Path $work 'osslsigncode-source'
[void](New-Item -ItemType Directory -Path $src)
$gitArgs=@('-c','http.sslVerify=true','-c','credential.helper=','-c','core.autocrlf=false','-c',"core.hooksPath=$emptyHooks")
[void](Run $git ($gitArgs+@('init')) $src)
[void](Run $git ($gitArgs+@('remote','add','origin','https://github.com/mtrojnar/osslsigncode.git')) $src)
[void](Run $git ($gitArgs+@('fetch','--no-tags','--depth=1','origin',$lock.osslsigncode.sourceCommit)) $src)
[void](Run $git ($gitArgs+@('checkout','--detach','FETCH_HEAD')) $src)
if((Run $git @('rev-parse','HEAD') $src) -cne $lock.osslsigncode.sourceCommit){throw 'upstream_checkout_commit_mismatch'}
[void](Run $git @('apply','--check',$patch) $src)
[void](Run $git @('apply',$patch) $src)
$provenance.patchedSources=@(@('osslsigncode.c','CMakeLists.txt')|ForEach-Object {
    [ordered]@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $src $_) -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$prefix=Join-Path $work 'prefix'
$opensslSrc=Join-Path $work 'openssl-3.5.9'
Write-Host 'Building pinned OpenSSL 3.5.9 LTS (static AMD64, upstream tests enabled).'
# Portable C implementation: no unpinned assembler download or installation.
# This removes assembly optimization only; TLS/certificate/CRL checks stay enabled.
$provenance.opensslConfigure=@('Configure','VC-WIN64A','no-shared','no-asm',"--prefix=$prefix","--openssldir=$prefix\ssl")
[void](Run $perl $provenance.opensslConfigure $opensslSrc)
[void](Run $nmake @('/nologo') $opensslSrc)
Write-Host 'OpenSSL compilation complete; starting all upstream tests with four TAP workers.'
$provenance.opensslTestArguments=@('/nologo','test','HARNESS_JOBS=4','VERBOSE_FAILURE=yes')
$testLog=Run $nmake $provenance.opensslTestArguments $opensslSrc
Write-Host $testLog.Substring([Math]::Max(0,$testLog.Length-9000))
$provenance.opensslUpstreamTestsPassed=$true
[void](Run $nmake @('/nologo','install_sw') $opensslSrc)
$provenance.opensslVersion=Run (Join-Path $prefix 'bin\openssl.exe') @('version','-a')
$zbuild=Join-Path $work 'zlib-build'
Write-Host 'Building pinned zlib 1.3.2 (static AMD64) and running its tests.'
[void](Run $cmake @('-S',(Join-Path $work 'zlib-1.3.2'),'-B',$zbuild,'-G','NMake Makefiles','-DCMAKE_BUILD_TYPE=Release',"-DCMAKE_INSTALL_PREFIX=$prefix",'-DZLIB_BUILD_SHARED=OFF','-DZLIB_BUILD_STATIC=ON','-DZLIB_BUILD_TESTING=ON'))
[void](Run $cmake @('--build',$zbuild))
$ztests=Run $ctest @('--test-dir',$zbuild,'--output-on-failure','--no-tests=error')
Write-Host $ztests
$provenance.zlibUpstreamTestsPassed=$true
[void](Run $cmake @('--install',$zbuild))
$provenance.installedDependencyBinaries=@(Get-ChildItem -LiteralPath $prefix -Recurse -File | Where-Object { $_.Extension -in @('.lib','.dll','.exe') } | Sort-Object FullName | ForEach-Object {
    [ordered]@{relativePath=$_.FullName.Substring($prefix.Length+1);sizeBytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$obuild=Join-Path $work 'osslsigncode-build'
Write-Host 'Building osslsigncode 2.14-gpubnb-tls1 with pinned static dependencies.'
$provenance.osslsigncodeConfigure=@('-S',$src,'-B',$obuild,'-G','NMake Makefiles','-DCMAKE_BUILD_TYPE=Release',"-DOPENSSL_ROOT_DIR=$prefix",'-DOPENSSL_USE_STATIC_LIBS=TRUE',"-DZLIB_ROOT=$prefix",'-DCMAKE_DISABLE_FIND_PACKAGE_Python3=TRUE')
[void](Run $cmake $provenance.osslsigncodeConfigure)
[void](Run $cmake @('--build',$obuild))
$tool=Join-Path $obuild 'osslsigncode.exe'
$provenance.toolVersion=Run $tool @('-v')
if($provenance.toolVersion -notmatch 'osslsigncode 2\.14-gpubnb-tls1' -or
    $provenance.toolVersion -notmatch 'OpenSSL 3\.5\.9'){throw 'built_tool_version_mismatch'}
$headers=Run $linker @('/dump','/headers',$tool)
$dependents=Run $linker @('/dump','/dependents',$tool)
if($headers -notmatch '8664 machine \(x64\)' -or
    $headers -notmatch 'Dynamic base' -or $headers -notmatch 'NX compatible' -or
    $headers -notmatch 'Control Flow Guard' -or $headers -notmatch 'High Entropy Virtual Addresses') {throw 'pe_architecture_or_security_flags_missing'}
if($dependents -match '(?i)libssl|libcrypto|zlib.*\.dll'){throw 'unexpected_dynamic_dependency'}
$provenance.peSecurity=[ordered]@{amd64=$true;aslr=$true;nx=$true;cfg=$true;highEntropyVA=$true;staticOpenSslAndZlib=$true;headers=$headers;dependents=$dependents}
$provenance.tool=[ordered]@{path=$tool;sizeBytes=(Get-Item -LiteralPath $tool).Length;sha256=(Get-FileHash -LiteralPath $tool -Algorithm SHA256).Hash.ToLowerInvariant();authenticodeStatus=[string](Get-AuthenticodeSignature -LiteralPath $tool).Status}
$provenance.rootStoresUnchanged=(@(Compare-Object $rootsBeforeBuild @(Get-RootStoreSnapshot)).Count -eq 0)
if(-not $provenance.rootStoresUnchanged){throw 'root_store_changed_during_build'}
$provenance.completedAtUtc=[DateTime]::UtcNow.ToString('o')
$manifest=Join-Path $work 'build-manifest.json'
$provenance|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $manifest -Encoding utf8NoBOM
Write-Host 'GPUBNB_HARDENED_BUILD_JSON_BEGIN'
$provenance|ConvertTo-Json -Depth 12|Write-Host
Write-Host 'GPUBNB_HARDENED_BUILD_JSON_END'
"GPUBNB_HARDENED_TOOL=$tool`nGPUBNB_HARDENED_MANIFEST=$manifest`nGPUBNB_HARDENED_BUILD_ROOT=$work" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
