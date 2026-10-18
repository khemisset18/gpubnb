#Requires -Version 5.1
Set-StrictMode -Version Latest
function Assert-Stage4Certificate {
    param($Certificate, [string]$ExpectedPublisherSha256, [int]$MinimumValidityHours = 24, [bool]$RequirePrivateKey=$true)
    if ($null -eq $Certificate -or ($RequirePrivateKey -and -not $Certificate.HasPrivateKey)) {
        throw 'stage4_private_test_certificate_unavailable'
    }
    $pin=$Certificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
    if ($pin -cne $ExpectedPublisherSha256) { throw 'stage4_private_wrong_signing_certificate' }
    if ($Certificate.Subject -notmatch 'LOCAL PHYSICAL TEST ONLY' -or
        $Certificate.NotBefore -gt (Get-Date) -or
        $Certificate.NotAfter -le (Get-Date).AddHours($MinimumValidityHours)) {
        throw 'stage4_private_test_certificate_invalid_or_expiring'
    }
    $eku=@($Certificate.Extensions | Where-Object { $_.Oid.Value -ceq '2.5.29.37' })
    if ($eku.Count -ne 1 -or -not (@($eku[0].EnhancedKeyUsages | ForEach-Object { $_.Value }) -contains '1.3.6.1.5.5.7.3.3')) {
        throw 'stage4_private_code_signing_eku_required'
    }
    $chain=[Security.Cryptography.X509Certificates.X509Chain]::new()
    try {
        $chain.ChainPolicy.RevocationMode=[Security.Cryptography.X509Certificates.X509RevocationMode]::Offline
        $chain.ChainPolicy.VerificationFlags=[Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
        $chain.ChainPolicy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
        if (-not $chain.Build($Certificate)) { throw 'stage4_private_certificate_chain_not_trusted' }
    } finally { $chain.Dispose() }
}

function Get-Stage4PeInfo {
    param([string]$Path)
    $b=[IO.File]::ReadAllBytes($Path)
    if ($b.Length -lt 512 -or [BitConverter]::ToUInt16($b,0) -ne 0x5a4d) { throw 'stage4_invalid_pe' }
    $p=[BitConverter]::ToInt32($b,60)
    if ($p -lt 64 -or $p+264 -gt $b.Length -or [BitConverter]::ToUInt32($b,$p) -ne 0x4550) { throw 'stage4_invalid_pe' }
    if ([BitConverter]::ToUInt16($b,$p+4) -ne 0x8664 -or [BitConverter]::ToUInt16($b,$p+24) -ne 0x20b) { throw 'stage4_not_amd64' }
    $count=[BitConverter]::ToUInt16($b,$p+6)
    $optSize=[BitConverter]::ToUInt16($b,$p+20)
    $o=$p+24
    if ($optSize -lt 240 -or $count -lt 1 -or $count -gt 96 -or $o+$optSize+$count*40 -gt $b.Length -or [BitConverter]::ToUInt32($b,$o+108) -lt 14) { throw 'stage4_invalid_pe_sections' }
    $sections=@()
    for($i=0;$i -lt $count;$i++) {
        $s=$o+$optSize+$i*40
        $raw=[BitConverter]::ToUInt32($b,$s+20);$size=[BitConverter]::ToUInt32($b,$s+16)
        if ([long]$raw+$size -gt $b.Length) { throw 'stage4_invalid_pe_section_bounds' }
        $sections+=@{rva=[BitConverter]::ToUInt32($b,$s+12);raw=$raw;size=$size}
    }
    function Resolve-Rva([uint32]$Rva,[int]$Size) {
        foreach($s in $sections) { $delta=[long]$Rva-$s.rva;if($delta -ge 0 -and $delta+$Size -le $s.size){return [int]($s.raw+$delta)} }
        throw 'stage4_invalid_pe_rva'
    }
    $imports=@()
    foreach($spec in @(@(1,20,12),@(13,32,4))) {
        $rva=[BitConverter]::ToUInt32($b,$o+112+$spec[0]*8)
        $size=[BitConverter]::ToUInt32($b,$o+116+$spec[0]*8)
        if($rva -eq 0){if($size -ne 0){throw 'stage4_invalid_pe_import_directory'};continue}
        $stride=$spec[1]
        if($size -lt $stride -or $size -gt 1048576){throw 'stage4_invalid_pe_import_directory'}
        $terminated=$false
        for($i=0;$i -lt [Math]::Min([Math]::Floor($size/$stride),512);$i++) {
            $a=Resolve-Rva ($rva+$i*$stride) $stride
            $nonzero=$false;for($j=0;$j -lt $stride;$j++){if($b[$a+$j] -ne 0){$nonzero=$true;break}}
            if(-not $nonzero){$terminated=$true;break}
            if($spec[0] -eq 13 -and [BitConverter]::ToUInt32($b,$a) -ne 1){throw 'stage4_delay_import_must_use_rva'}
            $start=Resolve-Rva ([BitConverter]::ToUInt32($b,$a+$spec[2])) 1
            $end=$start;while($end -lt [Math]::Min($start+260,$b.Length) -and $b[$end] -ne 0){$end++}
            if($end -ge [Math]::Min($start+260,$b.Length)){throw 'stage4_invalid_import_name'}
            $name=[Text.Encoding]::ASCII.GetString($b,$start,$end-$start).ToLowerInvariant()
            if($name -cnotmatch '^[a-z0-9_.-]+\.dll$'){throw 'stage4_invalid_import_name'}
            $imports+=$name
        }
        if(-not $terminated){throw 'stage4_unterminated_imports'}
    }
    $certOffset=[BitConverter]::ToUInt32($b,$o+112+4*8);$certSize=[BitConverter]::ToUInt32($b,$o+116+4*8)
    if(-not (($certOffset -eq 0 -and $certSize -eq 0) -or ($certOffset -gt 0 -and $certSize -ge 8 -and [long]$certOffset+$certSize -le $b.Length))){throw 'stage4_invalid_certificate_table'}
    [string[]]$sortedImports=@($imports|Select-Object -Unique)
    [Array]::Sort($sortedImports,[StringComparer]::Ordinal)
    return @{architecture='AMD64';imports=$sortedImports;certificateTablePresent=($certSize -gt 0)}
}

function Read-Stage4Package {
    param([string]$Directory,[string]$ManifestSha256,[string]$Commit,[string]$Publisher,[string]$Status='unsigned')
    if($Commit -cnotmatch '^[0-9a-f]{40}$'){throw 'stage4_exact_commit_required'}
    if($Publisher -cnotmatch '^[0-9a-f]{64}$' -or $Publisher -match '^(.)\1{63}$'){throw 'stage4_real_publisher_pin_required'}
    $root=(Resolve-Path -LiteralPath $Directory).Path
    if(Test-Path -LiteralPath (Join-Path $root 'INCOMPLETE-DO-NOT-INSTALL.txt')){throw 'stage4_incomplete_package_forbidden'}
    $mp=Join-Path $root 'stage4.manifest.json'
    if($ManifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or (Get-FileHash -LiteralPath $mp -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ManifestSha256){throw 'stage4_manifest_hash_mismatch'}
    $m=Get-Content -LiteralPath $mp -Raw | ConvertFrom-Json
    $kind=if($Status -ceq 'unsigned'){'STAGE4_UNSIGNED_PRIVATE_CANDIDATE'}else{'LOCAL_TEST_ONLY_NOT_RELEASE'}
    if($m.schemaVersion -ne 2 -or $m.kind -cne $kind -or $m.signatureStatus -cne $Status -or $m.installable -ne $false -or $m.publicBookabilityEnabled -ne $false -or $m.iddDriverIncluded -ne $false){throw 'stage4_private_package_policy_mismatch'}
    if($m.sourceCommit -cne $Commit){throw 'stage4_manifest_commit_mismatch'}
    if($m.publisherSha256 -cne $Publisher){throw 'stage4_manifest_publisher_mismatch'}
    foreach($kv in @{worker=1;mediaTransport=2;browserMedia=1;browserInput=1;mediaAbi=2}.GetEnumerator()){
        if($m.protocols.($kv.Key) -ne $kv.Value){throw 'stage4_protocol_mismatch'}
    }
    $names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe','gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
    if(@($m.files).Count -ne 4){throw 'stage4_exactly_four_components_required'}
    foreach($n in $names){if(@($m.files|Where-Object {$_.name -ceq $n}).Count -ne 1){throw 'stage4_exactly_four_components_required'}}
    foreach($p in @(Get-Item -LiteralPath $root -Force)+@(Get-ChildItem -LiteralPath $root -Force -Recurse)){
        if(($p.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'stage4_link_forbidden'}
        if(-not $p.PSIsContainer){
            if($p.Name -match '(?i)^\.env|\.(pfx|p12|pem|key|env)$'){throw 'stage4_key_or_secret_file_forbidden'}
            if($p.Extension -match '(?i)^\.(exe|dll)$' -and ($p.DirectoryName -ine $root -or $names -cnotcontains $p.Name)){throw 'stage4_unexpected_binary'}
        }
    }
    foreach($f in $m.files){
        $path=Join-Path $root $f.name
        if(-not (Test-Path -LiteralPath $path -PathType Leaf)){throw "stage4_component_missing:$($f.name)"}
        if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw "stage4_component_hash_mismatch:$($f.name)"}
        $pe=Get-Stage4PeInfo $path
        if($f.architecture -cne 'AMD64' -or (@($f.imports)-join ',') -cne (@($pe.imports)-join ',')){throw "stage4_pe_metadata_mismatch:$($f.name):expected=$(@($f.imports)-join ','):observed=$(@($pe.imports)-join ',')"}
        if($Status -ceq 'unsigned' -and $pe.certificateTablePresent){throw 'stage4_source_must_be_unsigned'}
        if($Status -ceq 'private-signed' -and -not $pe.certificateTablePresent){throw 'stage4_signature_table_missing'}
    }
    $ip=Join-Path $root 'build-identities.json'
    if((Get-FileHash -LiteralPath $ip -Algorithm SHA256).Hash.ToLowerInvariant() -cne $m.buildIdentitiesSha256){throw 'stage4_identity_hash_mismatch'}
    $id=Get-Content -LiteralPath $ip -Raw | ConvertFrom-Json
    if($id.agent.frozen -ne $true -or $id.agent.agentVersion -cne '0.6.6' -or $id.agent.buildCommit -cne $Commit.Substring(0,12)){throw 'stage4_agent_identity_mismatch'}
    if($id.helper.sourceCommit -cne $Commit -or $id.worker.sourceCommit -cne $Commit -or $id.media.sourceCommit -cne $Commit){throw 'stage4_component_commit_mismatch'}
    if($id.helper.workerSignerSha256 -cne $Publisher -or $id.worker.mediaSignerSha256 -cne $Publisher){throw 'stage4_embedded_pin_mismatch'}
    if($id.helper.mutationAuthority -cne 'release-candidate'){throw 'stage4_wrong_helper_authority'}
    foreach($kv in @{workerProtocol=1;mediaTransportProtocol=2;browserMediaProtocol=1;browserInputProtocol=1}.GetEnumerator()){
        if($id.helper.($kv.Key) -ne $kv.Value){throw 'stage4_protocol_mismatch'}
    }
    if($id.media.mediaAbi -ne 2 -or $id.media.nvencApi -cne '13.0'){throw 'stage4_media_abi_mismatch'}
    if($Status -ceq 'private-signed' -and $m.unsignedManifestSha256 -cnotmatch '^[0-9a-f]{64}$'){throw 'stage4_unsigned_provenance_missing'}
    if($Status -ceq 'private-signed'){
        $up=Join-Path $root 'unsigned-stage4.manifest.json'
        if((Get-FileHash $up -Algorithm SHA256).Hash.ToLowerInvariant() -cne $m.unsignedManifestSha256){throw 'stage4_unsigned_manifest_hash_mismatch'}
        $u=Get-Content $up -Raw|ConvertFrom-Json
        if($u.kind -cne 'STAGE4_UNSIGNED_PRIVATE_CANDIDATE' -or $u.sourceCommit -cne $Commit -or $u.publisherSha256 -cne $Publisher -or @($u.files).Count -ne 4){throw 'stage4_unsigned_provenance_mismatch'}
        foreach($f in $m.files){
            $old=@($u.files|Where-Object {$_.name -ceq $f.name})
            if($old.Count -ne 1 -or $f.unsignedSha256 -cne $old[0].sha256){throw 'stage4_unsigned_file_provenance_mismatch'}
        }
    }
    return $m
}

function Assert-Stage4NewOutput {
    param([string]$Path, [string]$SourceDirectory)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'stage4_private_output_required' }
    $target=[IO.Path]::GetFullPath($Path).TrimEnd('\')
    $source=[IO.Path]::GetFullPath($SourceDirectory).TrimEnd('\')
    if (Test-Path -LiteralPath $target) { throw 'stage4_private_output_must_be_new' }
    if ($target -ieq $source -or $target.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase)) {
        throw 'stage4_private_output_must_be_separate'
    }
    if ($target -match '(?i)\\Program Files(?: \(x86\))?(?:\\|$)|\\Windows(?:\\|$)|\\ProgramData(?:\\|$)') {
        throw 'stage4_private_installed_path_forbidden'
    }
    # Resolve the existing parent to defeat junctions into protected/installed paths.
    $parent=Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'stage4_private_existing_parent_required' }
    $cursor=Get-Item -LiteralPath $parent -Force
    while ($null -ne $cursor) {
        if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'stage4_private_output_reparse_point_forbidden' }
        $cursor=$cursor.Parent
    }
    return $target
}
