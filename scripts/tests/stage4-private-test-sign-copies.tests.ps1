#Requires -Version 5.1
# Synthetic offline fixtures only. No signing key, trust change or installation.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$scripts=Split-Path -Parent $PSScriptRoot
. (Join-Path $scripts 'stage4-package-common.ps1')
foreach($name in @('stage4-private-test-sign-copies.ps1','verify-stage4-package.ps1','stage4-package-common.ps1','build-stage4-unsigned-package.ps1','stage4-pc1-inventory.ps1','stage4-test-ready-audit.ps1','stage4-backup-installed.ps1','qualification-preflight-pc-a.ps1','qualification-preflight-pc-b.ps1','verify-windows-release.ps1')){
    $tokens=$null;$errors=$null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $scripts $name),[ref]$tokens,[ref]$errors)
    if($errors.Count -ne 0){throw "stage4_parser_failed:$name`:$($errors[0].Message)"}
}
$source=Get-Content (Join-Path $scripts 'stage4-private-test-sign-copies.ps1') -Raw
if($source -match '2b055992f7521505d0387dd4c876e36794fffd63|Stop-Service|Set-Service|Import-Certificate|Export-PfxCertificate|Restart-Computer'){throw 'stage4_private_forbidden_legacy_or_machine_mutation'}
$dir=Join-Path ([IO.Path]::GetTempPath()) ('stage4-policy-test-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($dir)
$commit='1234567890abcdef1234567890abcdef12345678'
$pin='200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a'
function Expect-Failure([string]$Code,[scriptblock]$Action){
    $message='';try{& $Action | Out-Null}catch{$message=$_.Exception.Message}
    if(-not $message.StartsWith($Code)){throw "expected_$Code`_got:$message"}
    Write-Host "PASS $Code"
}
function Save-Manifest {
    [IO.File]::WriteAllText((Join-Path $dir 'stage4.manifest.json'),($script:m|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    $script:digest=(Get-FileHash (Join-Path $dir 'stage4.manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Read-Fixture { Read-Stage4Package $dir $script:digest $commit $pin 'unsigned' }
try {
    $b=New-Object byte[] 1024
    [Array]::Copy([Text.Encoding]::ASCII.GetBytes('MZ'),0,$b,0,2)
    [Array]::Copy([BitConverter]::GetBytes([int]128),0,$b,60,4)
    [Array]::Copy([BitConverter]::GetBytes([int]0x4550),0,$b,128,4)
    foreach($pair in @(@(132,0x8664),@(134,1),@(148,240),@(152,0x20b))){[Array]::Copy([BitConverter]::GetBytes([uint16]$pair[1]),0,$b,$pair[0],2)}
    foreach($pair in @(@(260,16),@(272,0x1000),@(276,40),@(400,512),@(404,0x1000),@(408,512),@(412,512),@(524,0x1040))){[Array]::Copy([BitConverter]::GetBytes([int]$pair[1]),0,$b,$pair[0],4)}
    [Array]::Copy([Text.Encoding]::ASCII.GetBytes("KERNEL32.dll`0"),0,$b,576,13)
    # Ordinal PE import ordering must match the independent Python verifier,
    # regardless of the Windows runner's culture/punctuation collation rules.
    $ordering=[byte[]]$b.Clone()
    foreach($pair in @(@(276,60),@(524,0x1080),@(544,0x10b0))){[Array]::Copy([BitConverter]::GetBytes([int]$pair[1]),0,$ordering,$pair[0],4)}
    [Array]::Copy([Text.Encoding]::ASCII.GetBytes("msvcp140.dll`0"),0,$ordering,640,13)
    [Array]::Copy([Text.Encoding]::ASCII.GetBytes("msvcp140_atomic_wait.dll`0"),0,$ordering,688,24)
    $orderingPath=Join-Path $dir 'ordering.dat';[IO.File]::WriteAllBytes($orderingPath,$ordering)
    $importOrder=Get-Stage4PeInfo $orderingPath
    if(($importOrder.imports -join ',') -cne 'msvcp140.dll,msvcp140_atomic_wait.dll'){throw 'stage4_import_order_not_ordinal'}
    Remove-Item $orderingPath
    Write-Host 'PASS PE imports use ordinal rather than culture-dependent ordering'
    $records=@()
    foreach($name in @('gpubnb-agent.exe','gpubnb-windows-stream.exe','gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')){
        $path=Join-Path $dir $name;[IO.File]::WriteAllBytes($path,$b)
        $records+=@{name=$name;sha256=(Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant();architecture='AMD64';imports=@('kernel32.dll')}
    }
    $identity=@{agent=@{frozen=$true;agentVersion='0.6.6';buildCommit=$commit.Substring(0,12)};
        helper=@{sourceCommit=$commit;workerSignerSha256=$pin;mutationAuthority='release-candidate';workerProtocol=1;mediaTransportProtocol=2;browserMediaProtocol=1;browserInputProtocol=1};
        worker=@{sourceCommit=$commit;mediaSignerSha256=$pin};media=@{sourceCommit=$commit;mediaAbi=2;nvencApi='13.0'}}
    $ip=Join-Path $dir 'build-identities.json';[IO.File]::WriteAllText($ip,($identity|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    $script:m=@{schemaVersion=2;kind='STAGE4_UNSIGNED_PRIVATE_CANDIDATE';signatureStatus='unsigned';sourceCommit=$commit;publisherSha256=$pin;
        protocols=@{worker=1;mediaTransport=2;browserMedia=1;browserInput=1;mediaAbi=2};installable=$false;publicBookabilityEnabled=$false;iddDriverIncluded=$false;
        files=$records;buildIdentitiesSha256=(Get-FileHash $ip -Algorithm SHA256).Hash.ToLowerInvariant()}
    Save-Manifest
    $positive=Read-Fixture
    if($positive.files.Count -ne 4){throw 'positive_fixture_failed'}
    Write-Host 'PASS exact four-component unsigned package, actual PE/imports and identities'
    $incomplete=Join-Path $dir 'INCOMPLETE-DO-NOT-INSTALL.txt';[IO.File]::WriteAllText($incomplete,'incomplete')
    Expect-Failure 'stage4_incomplete_package_forbidden' {Read-Fixture}
    Remove-Item $incomplete
    Expect-Failure 'stage4_manifest_hash_mismatch' {Read-Stage4Package $dir ('a'*64) $commit $pin}
    Expect-Failure 'stage4_manifest_commit_mismatch' {Read-Stage4Package $dir $script:digest ('a'*40) $pin}
    Expect-Failure 'stage4_real_publisher_pin_required' {Read-Stage4Package $dir $script:digest $commit ('1'*64)}
    $script:m.publisherSha256='ab'*32;Save-Manifest
    Expect-Failure 'stage4_manifest_publisher_mismatch' {Read-Fixture}
    $script:m.publisherSha256=$pin;Save-Manifest
    $path=Join-Path $dir 'gpubnb-agent.exe'
    Remove-Item $path
    Expect-Failure 'stage4_component_missing' {Read-Fixture}
    [IO.File]::WriteAllText($path,'changed')
    Expect-Failure 'stage4_component_hash_mismatch' {Read-Fixture}
    $x86=[byte[]]$b.Clone();[Array]::Copy([BitConverter]::GetBytes([uint16]0x14c),0,$x86,132,2)
    [IO.File]::WriteAllBytes($path,$x86);$script:m.files[0].sha256=(Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant();Save-Manifest
    Expect-Failure 'stage4_not_amd64' {Read-Fixture}
    [IO.File]::WriteAllBytes($path,$b);$script:m.files[0].sha256=(Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant();Save-Manifest
    $script:m.files[0].imports=@();Save-Manifest
    Expect-Failure 'stage4_pe_metadata_mismatch' {Read-Fixture}
    $script:m.files[0].imports=@('kernel32.dll');Save-Manifest
    $identity.helper.workerSignerSha256='ab'*32
    [IO.File]::WriteAllText($ip,($identity|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    $script:m.buildIdentitiesSha256=(Get-FileHash $ip -Algorithm SHA256).Hash.ToLowerInvariant();Save-Manifest
    Expect-Failure 'stage4_embedded_pin_mismatch' {Read-Fixture}
    Expect-Failure 'stage4_private_test_certificate_unavailable' {Assert-Stage4Certificate $null $pin}
    $rsa=[Security.Cryptography.RSA]::Create();$rsa.KeySize=2048
    try {
        $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=GPUbnb LOCAL PHYSICAL TEST ONLY ephemeral policy test',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $oids=[Security.Cryptography.OidCollection]::new();[void]$oids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$false))
        $expired=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-2),[DateTimeOffset]::UtcNow.AddDays(-1))
        try {
            $cp=$expired.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
            Expect-Failure 'stage4_private_test_certificate_invalid_or_expiring' {Assert-Stage4Certificate $expired $cp}
            Expect-Failure 'stage4_private_wrong_signing_certificate' {Assert-Stage4Certificate $expired $pin}
        }finally{$expired.Dispose()}
        $valid=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddDays(7))
        try {
            $cp=$valid.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
            Expect-Failure 'stage4_private_certificate_chain_not_trusted' {Assert-Stage4Certificate $valid $cp}
        }finally{$valid.Dispose()}
        $noEkuRequest=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=GPUbnb LOCAL PHYSICAL TEST ONLY missing EKU',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $noEku=$noEkuRequest.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddDays(7))
        try {
            $cp=$noEku.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
            Expect-Failure 'stage4_private_code_signing_eku_required' {Assert-Stage4Certificate $noEku $cp}
        }finally{$noEku.Dispose()}
    }finally{$rsa.Dispose()}
    Expect-Failure 'windows_release_install_smoke_requires_explicit_disposable_github_runner' {& (Join-Path $scripts 'verify-windows-release.ps1') -InstallerPath 'does-not-exist.exe'}
    Expect-Failure 'stage4_private_output_must_be_new' {Assert-Stage4NewOutput $dir $dir}
    Expect-Failure 'stage4_private_output_must_be_separate' {Assert-Stage4NewOutput (Join-Path $dir 'child') $dir}
    $validOut=Join-Path (Split-Path -Parent $dir) ('stage4-positive-output-'+[guid]::NewGuid().ToString('N'))
    if((Assert-Stage4NewOutput $validOut $dir) -cne [IO.Path]::GetFullPath($validOut)){throw 'stage4_positive_output_failed'}
    if(Test-Path $validOut){throw 'stage4_preflight_created_output'}
    Write-Host 'PASS separate new output accepted without creating it'
} finally {Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue}
