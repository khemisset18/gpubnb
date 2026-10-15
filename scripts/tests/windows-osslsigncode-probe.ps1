# Isolated public TSA interoperability probe. Never creates a code signature.
# Only public certificate stores are read; no key or trust-store import is used.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -cne 'khemisset18/gpubnb') {
    throw 'tsa_probe_requires_isolated_github_hosted_windows'
}
Add-Type -AssemblyName System.Security.Cryptography.Pkcs

function Get-RootSnapshot {
    $rows = foreach ($scope in @('LocalMachine', 'CurrentUser')) {
        Get-ChildItem -LiteralPath "Cert:\$scope\Root" | ForEach-Object {
            "$scope|$($_.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256))"
        }
    }
    return @($rows | Sort-Object -Unique)
}
$rootsBefore = @(Get-RootSnapshot)
$trustedRoots = [System.Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
foreach ($scope in @('LocalMachine', 'CurrentUser')) {
    foreach ($cert in @(Get-ChildItem -LiteralPath "Cert:\$scope\Root")) {
        [void]$trustedRoots.Add($cert)
    }
}
function Get-PublicCertHash($Certificate) {
    return $Certificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
}
function Test-TsaChain($Token) {
    $cms = $Token.AsSignedCms()
    $cms.CheckSignature($true)
    if ($cms.SignerInfos.Count -ne 1) { throw 'tsa_signer_count' }
    $tsa = $cms.SignerInfos[0].Certificate
    if ($null -eq $tsa) { throw 'tsa_certificate_missing' }
    $eku = @($tsa.Extensions | Where-Object { $_.Oid.Value -ceq '2.5.29.37' })
    if ($eku.Count -ne 1 -or -not $eku[0].Critical -or
        $eku[0].EnhancedKeyUsages.Count -ne 1 -or
        $eku[0].EnhancedKeyUsages[0].Value -cne '1.3.6.1.5.5.7.3.8') {
        throw 'tsa_eku_not_exclusive_critical_timestamping'
    }
    $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
    try {
        # Memory-only roots are exactly the original Windows trusted roots.
        # Provider-supplied certificates go ONLY in ExtraStore, never trust roots.
        $chain.ChainPolicy.TrustMode = [System.Security.Cryptography.X509Certificates.X509ChainTrustMode]::CustomRootTrust
        $chain.ChainPolicy.CustomTrustStore.AddRange($trustedRoots)
        $chain.ChainPolicy.ExtraStore.AddRange($cms.Certificates)
        $chain.ChainPolicy.DisableCertificateDownloads = $true
        $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::Online
        $chain.ChainPolicy.RevocationFlag = [System.Security.Cryptography.X509Certificates.X509RevocationFlag]::ExcludeRoot
        $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
        $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(10)
        $chain.ChainPolicy.VerificationTime = $Token.TokenInfo.Timestamp.UtcDateTime
        [void]$chain.ChainPolicy.ApplicationPolicy.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.8'))
        $valid = $chain.Build($tsa)
        $root = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate
        $rootHash = Get-PublicCertHash $root
        $previouslyTrusted = @($trustedRoots | Where-Object { (Get-PublicCertHash $_) -ceq $rootHash }).Count -gt 0
        return [ordered]@{
            valid = ($valid -and $previouslyTrusted)
            statuses = @($chain.ChainStatus | ForEach-Object { [string]$_.Status })
            signerSubject = $tsa.Subject
            signerCertificateSha256 = Get-PublicCertHash $tsa
            rootCertificateSha256 = $rootHash
            rootPreviouslyTrusted = $previouslyTrusted
            timestampUtc = $Token.TokenInfo.Timestamp.UtcDateTime.ToString('o')
            hashAlgorithmOid = $Token.TokenInfo.HashAlgorithmId.Value
        }
    } finally { $chain.Dispose() }
}
function Get-EmbeddedCms([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw 'fixture_not_pe' }
    $pe = [BitConverter]::ToInt32($bytes, 60)
    if ($pe -lt 64 -or $pe + 24 + 112 + 40 -gt $bytes.Length -or
        [BitConverter]::ToUInt32($bytes, $pe) -ne 0x4550) { throw 'fixture_pe_header_invalid' }
    $opt = $pe + 24
    $magic = [BitConverter]::ToUInt16($bytes, $opt)
    $directory = if ($magic -eq 0x20b) { $opt + 112 } elseif ($magic -eq 0x10b) { $opt + 96 } else { throw 'fixture_pe_magic' }
    $offset = [BitConverter]::ToUInt32($bytes, $directory + 32)
    $size = [BitConverter]::ToUInt32($bytes, $directory + 36)
    if ($offset -eq 0 -or $size -lt 8 -or ([long]$offset + $size) -gt $bytes.Length) { throw 'fixture_embedded_signature_missing' }
    $length = [BitConverter]::ToUInt32($bytes, $offset)
    if ($length -lt 8 -or $length -gt $size -or [BitConverter]::ToUInt16($bytes, $offset + 6) -ne 2) { throw 'fixture_win_certificate_invalid' }
    $raw = [byte[]]::new($length - 8)
    [Array]::Copy($bytes, $offset + 8, $raw, 0, $raw.Length)
    $cms = [System.Security.Cryptography.Pkcs.SignedCms]::new()
    $cms.Decode($raw)
    return $cms
}

# This probe has no signing command, private key, PFX, token or GPUbnb binary.
if ($env:GITHUB_REF_NAME -cne 'prep/stage4-osslsigncode-probe-20261015') {
    throw 'osslsigncode_probe_wrong_branch'
}
function Get-ByteHash([byte[]]$Bytes) {
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-PrimaryDescription($Cms) {
    if ($Cms.SignerInfos.Count -ne 1) { throw 'primary_signer_ambiguous' }
    $s = $Cms.SignerInfos[0]
    if ($null -eq $s.Certificate) { throw 'primary_certificate_missing' }
    $attrs = @($s.SignedAttributes | ForEach-Object {
        $oid = $_.Oid.Value
        foreach ($value in $_.Values) { "$oid|$(Get-ByteHash $value.RawData)" }
    } | Sort-Object)
    return [ordered]@{
        signerSha256 = Get-PublicCertHash $s.Certificate
        digestOid = $s.DigestAlgorithm.Value
        signatureBytesSha256 = Get-ByteHash $s.GetSignature()
        signedContentSha256 = Get-ByteHash $Cms.ContentInfo.Content
        signedAttributes = $attrs
    }
}
function Assert-SamePrimary($Before, $After) {
    foreach ($name in @('signerSha256', 'digestOid', 'signatureBytesSha256', 'signedContentSha256')) {
        if ($Before[$name] -cne $After[$name]) { throw 'primary_signature_changed' }
    }
    if (@(Compare-Object @($Before.signedAttributes) @($After.signedAttributes)).Count -ne 0) {
        throw 'primary_signed_attributes_changed'
    }
}
function Invoke-ProbeTool([string]$FilePath, [string[]]$Arguments, [int]$TimeoutMs = 45000) {
    if ($Arguments -contains 'sign' -or $Arguments -contains '-key' -or
        $Arguments -contains '-pkcs12' -or $Arguments -contains '-TSA-key' -or
        $Arguments -contains '-noverifypeer' -or $Arguments -contains '-time' -or
        $Arguments -contains '-TSA-time') { throw 'forbidden_probe_operation' }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $FilePath
    $start.WorkingDirectory = $scratch
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # The third-party process receives no runner tokens, key settings or proxies.
    $start.Environment.Clear()
    $start.Environment['SystemRoot'] = $env:SystemRoot
    $start.Environment['WINDIR'] = $env:WINDIR
    $start.Environment['TEMP'] = $scratch
    $start.Environment['TMP'] = $scratch
    $start.Environment['PATH'] = "$([IO.Path]::GetDirectoryName($FilePath));$env:WINDIR\System32"
    foreach ($arg in $Arguments) { $start.ArgumentList.Add($arg) }
    $p = [Diagnostics.Process]::new()
    $p.StartInfo = $start
    try {
        if (-not $p.Start()) { throw 'probe_process_start_failed' }
        $stdout = $p.StandardOutput.ReadToEndAsync()
        $stderr = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($TimeoutMs)) {
            $p.Kill($true)
            $p.WaitForExit()
            throw 'probe_process_timeout'
        }
        $out = $stdout.GetAwaiter().GetResult()
        $err = $stderr.GetAwaiter().GetResult()
        return [ordered]@{
            exitCode = $p.ExitCode
            stdout = $out.Substring(0, [Math]::Min(10000, $out.Length))
            stderr = $err.Substring(0, [Math]::Min(10000, $err.Length))
        }
    } finally { $p.Dispose() }
}
function Download-ReleaseAsset([string]$Destination) {
    $url = [Uri]'https://github.com/mtrojnar/osslsigncode/releases/download/2.14/osslsigncode-2.14-windows-x64-mingw.zip'
    $h = [Net.Http.HttpClientHandler]::new()
    $h.AllowAutoRedirect = $false
    $h.UseDefaultCredentials = $false
    $h.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($h)
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    try {
        for ($i=0; $i -lt 6; $i++) {
            if ($url.Scheme -cne 'https' -or $url.UserInfo -ne '' -or
                $url.Host -notin @('github.com','release-assets.githubusercontent.com','objects.githubusercontent.com')) {
                throw 'release_redirect_not_allowlisted_https'
            }
            $r = $client.GetAsync($url).GetAwaiter().GetResult()
            try {
                if ([int]$r.StatusCode -in @(301,302,303,307,308)) {
                    if ($null -eq $r.Headers.Location) { throw 'release_redirect_missing' }
                    $url = [Uri]::new($url,$r.Headers.Location)
                    continue
                }
                if (-not $r.IsSuccessStatusCode) { throw 'release_download_http_error' }
                $bytes = $r.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
                if ($bytes.Length -ne 2259975) { throw 'release_archive_size_mismatch' }
                if ((Get-ByteHash $bytes) -cne '9a1722aaf62a27852c4eb9c35749a0248065052d0ae0a93d4ed6bb49def027f2') {
                    throw 'release_archive_hash_mismatch'
                }
                [IO.File]::WriteAllBytes($Destination,$bytes)
                return
            } finally { $r.Dispose() }
        }
        throw 'release_redirect_limit'
    } finally { $client.Dispose(); $h.Dispose() }
}
function Expand-CheckedArchive([string]$Archive, [string]$Destination) {
    $z = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        if ($z.Entries.Count -gt 128) { throw 'release_archive_entry_limit' }
        $total = 0L
        $base = [IO.Path]::GetFullPath($Destination) + [IO.Path]::DirectorySeparatorChar
        foreach ($entry in $z.Entries) {
            $target = [IO.Path]::GetFullPath([IO.Path]::Combine($base,$entry.FullName))
            if (-not $target.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) { throw 'release_zip_path_invalid' }
            $total += $entry.Length
            if ($entry.Length -gt 33554432 -or $total -gt 104857600) { throw 'release_zip_expansion_limit' }
        }
    } finally { $z.Dispose() }
    Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
}
Add-Type -TypeDefinition @'
using System;
using System.Linq;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
public sealed class PublicTlsResult {
    public string Host;
    public bool CallbackReached;
    public bool HandshakeSucceeded;
    public string PolicyErrors;
    public string[] ChainStatuses;
    public string CertificateSha256;
    public string ErrorType;
}
public static class PublicTlsControl {
    public static PublicTlsResult Check(string host) {
        var r=new PublicTlsResult {Host=host, ChainStatuses=Array.Empty<string>()};
        using (var tcp=new TcpClient()) {
            try {
                if (!tcp.ConnectAsync(host,443).Wait(12000)) throw new TimeoutException();
                using (var ssl=new SslStream(tcp.GetStream(),false,(sender,cert,chain,errors)=>{
                    r.CallbackReached=true;
                    r.PolicyErrors=errors.ToString();
                    r.ChainStatuses=chain==null ? Array.Empty<string>() : chain.ChainStatus.Select(s=>s.Status.ToString()).ToArray();
                    r.CertificateSha256=cert==null ? null : Convert.ToHexString(SHA256.HashData(cert.GetRawCertData())).ToLowerInvariant();
                    return errors==SslPolicyErrors.None;
                })) {
                    if (!ssl.AuthenticateAsClientAsync(host).Wait(12000)) throw new TimeoutException();
                    r.HandshakeSucceeded=ssl.IsAuthenticated && ssl.IsEncrypted;
                }
            } catch (Exception e) {r.ErrorType=(e.InnerException??e).GetType().Name;}
        }
        return r;
    }
}
'@
$scratch = Join-Path $env:RUNNER_TEMP ('gpubnb-osslsigncode-probe-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $scratch)
$report = [ordered]@{
    schemaVersion=1
    probe='windows-isolated-osslsigncode-public-fixture'
    repository=$env:GITHUB_REPOSITORY
    workflowCommit=$env:GITHUB_SHA
    collectedAtUtc=[DateTime]::UtcNow.ToString('o')
    windowsVersion=[Environment]::OSVersion.Version.ToString()
    powerShellVersion=$PSVersionTable.PSVersion.ToString()
    sourceTag='2.14'
    sourceCommit='beec94e308d1a1e03ca17b05fe089d93c6303e90'
    releaseArchiveSha256='9a1722aaf62a27852c4eb9c35749a0248065052d0ae0a93d4ed6bb49def027f2'
    codeSigningPerformed=$false
    privateKeyAccessed=$false
    rootsImported=$false
    fixtureNeverExecuted=$true
    gpuBnbCandidateModified=$false
    pc1OrPc2Accessed=$false
    providerApproved=$false
    extraCostEuros=0
    tlsPeerValidationProven=$false
    tlsHostnameValidationProven=$false
    functionalTimestampPass=$false
    secureIntegrationPass=$false
    negativeTls=@()
    positive=$null
}
$fixtureSource=$null
$sourceHash=$null
try {
    $signTool = Get-Item -LiteralPath 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe' -ErrorAction Stop
    $st = Get-AuthenticodeSignature -LiteralPath $signTool.FullName
    if ($st.Status -ne 'Valid' -or $st.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation(?:,|$)') {
        throw 'signtool_not_valid_microsoft'
    }
    $report.signTool = [ordered]@{
        path=$signTool.FullName
        fileVersion=$signTool.VersionInfo.FileVersion
        productVersion=$signTool.VersionInfo.ProductVersion
        sha256=(Get-FileHash -LiteralPath $signTool.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        signerSha256=Get-PublicCertHash $st.SignerCertificate
    }
    $zip = Join-Path $scratch 'osslsigncode-2.14.zip'
    Download-ReleaseAsset $zip
    $toolDir = Join-Path $scratch 'osslsigncode'
    Expand-CheckedArchive $zip $toolDir
    $tools = @(Get-ChildItem -LiteralPath $toolDir -Recurse -File -Filter osslsigncode.exe)
    if ($tools.Count -ne 1) { throw 'release_executable_missing_or_ambiguous' }
    $ossl = $tools[0]
    $version = Invoke-ProbeTool $ossl.FullName @('-v')
    if ($version.exitCode -ne 0 -or $version.stdout -notmatch 'osslsigncode 2\.14') { throw 'release_version_mismatch' }
    $report.tool = [ordered]@{
        fileSha256=(Get-FileHash -LiteralPath $ossl.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        authenticodeStatus=[string](Get-AuthenticodeSignature -LiteralPath $ossl.FullName).Status
        version=$version
        files=@(Get-ChildItem -LiteralPath $toolDir -File -Recurse | ForEach-Object {
            [ordered]@{relativePath=$_.FullName.Substring($toolDir.Length+1);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
        })
        upstreamTagSignatureVerified=$false
        reproducibleBuildProven=$false
    }
    $fixture = $null
    $paths = @((Join-Path $PSHOME 'pwsh.exe'), $signTool.FullName)
    foreach ($path in $paths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $sig = Get-AuthenticodeSignature -LiteralPath $path
        $now = [DateTime]::UtcNow
        if ($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or
            $sig.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation(?:,|$)' -or
            $sig.SignerCertificate.NotBefore.ToUniversalTime() -gt $now -or
            $sig.SignerCertificate.NotAfter.ToUniversalTime() -le $now) { continue }
        $cms = Get-EmbeddedCms $path
        if ($cms.SignerInfos.Count -ne 1 -or $cms.SignerInfos[0].DigestAlgorithm.Value -cne '2.16.840.1.101.3.4.2.1') { continue }
        $originalPrimary = Get-PrimaryDescription $cms
        $copy = Join-Path $scratch 'fixture-without-timestamp.exe'
        Copy-Item -LiteralPath $path -Destination $copy
        $remove = Invoke-ProbeTool $signTool.FullName @('remove','/u',$copy)
        if ($remove.exitCode -ne 0) { throw 'fixture_timestamp_removal_failed' }
        $after = Get-AuthenticodeSignature -LiteralPath $copy
        if ($after.Status -ne 'Valid' -or $null -ne $after.TimeStamperCertificate) { throw 'fixture_baseline_signature_invalid' }
        $primary = Get-PrimaryDescription (Get-EmbeddedCms $copy)
        Assert-SamePrimary $originalPrimary $primary
        $verify = Invoke-ProbeTool $signTool.FullName @('verify','/pa','/all','/v',$copy)
        if ($verify.exitCode -ne 0) { throw 'fixture_baseline_signtool_invalid' }
        $fixture = $copy
        $fixtureSource = $path
        $sourceHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        $report.fixture = [ordered]@{
            sourcePath=$path;sourceSha256=$sourceHash
            beforeTimestampSha256=(Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()
            primary=$primary;baselineWindowsStatus=[string]$after.Status
            baselineSignTool=$verify;originalPrimaryPreservedDuringTimestampRemoval=$true
            signerNotAfterUtc=$after.SignerCertificate.NotAfter.ToUniversalTime().ToString('o')
        }
        break
    }
    if ($null -eq $fixture) { throw 'no_current_valid_microsoft_sha256_embedded_fixture' }
    # Public root DER bytes only, written as a temporary PEM. No key or import.
    $ca = Join-Path $scratch 'original-windows-roots.pem'
    $pem = @($trustedRoots | ForEach-Object {
        '-----BEGIN CERTIFICATE-----'
        [Convert]::ToBase64String($_.RawData,[Base64FormattingOptions]::InsertLineBreaks)
        '-----END CERTIFICATE-----'
    }) -join [Environment]::NewLine
    [IO.File]::WriteAllText($ca,$pem,[Text.Encoding]::ASCII)
    $report.httpsTrust = [ordered]@{
        publicRootsOnly=$true;rootCount=$trustedRoots.Count
        pemSha256=(Get-FileHash -LiteralPath $ca -Algorithm SHA256).Hash.ToLowerInvariant()
        noRootImported=$true;explicitHttpsCAfile=$true
    }
    foreach ($test in @(
        @{name='untrusted-peer';host='self-signed.badssl.com';pattern='certificate verify failed|self.signed|unable to get local issuer certificate'},
        @{name='wrong-host';host='wrong.host.badssl.com';pattern='hostname mismatch|IP address mismatch|no alternative certificate subject name|certificate subject name'}
    )) {
        $control = [PublicTlsControl]::Check($test.host)
        $target = Join-Path $scratch ($test.name+'.exe')
        $diagnostic = Invoke-ProbeTool $ossl.FullName @('add','-h','sha256','-ts',("https://"+$test.host+"/"),'-HTTPS-CAfile',$ca,'-verbose','-in',$fixture,'-out',$target)
        $combined = $diagnostic.stdout + [Environment]::NewLine + $diagnostic.stderr
        $expectedControl = if ($test.name -ceq 'untrusted-peer') {
            $control.CallbackReached -and $control.PolicyErrors -match 'RemoteCertificateChainErrors'
        } else {
            $control.CallbackReached -and $control.PolicyErrors -ceq 'RemoteCertificateNameMismatch' -and $control.ChainStatuses.Count -eq 0
        }
        $rejected = $expectedControl -and $diagnostic.exitCode -ne 0 -and $combined -match $test.pattern
        $report.negativeTls += [ordered]@{
            name=$test.name;url=("https://"+$test.host+"/");strictWindowsControl=$control
            expectedFaultIndependentlyObserved=$expectedControl
            osslsigncode=$diagnostic;tlsSpecificRejectionProven=$rejected
            outputCreated=(Test-Path -LiteralPath $target -PathType Leaf)
        }
        if ($test.name -ceq 'untrusted-peer') { $report.tlsPeerValidationProven=$rejected }
        else { $report.tlsHostnameValidationProven=$rejected }
    }
    # Measurement on PUBLIC fixture only. Any failed TLS gate keeps integration NO-GO.
    $row = [ordered]@{
        url='https://rfc3161.ai.moda/';approved=$false;signatureAdded=$false
        afterTimestampSha256=$null;technicalPass=$false;errorCode=$null
    }
    try {
        $row.strictWindowsTlsControl = [PublicTlsControl]::Check('rfc3161.ai.moda')
        if (-not $row.strictWindowsTlsControl.HandshakeSucceeded) { throw 'positive_tls_control_failed' }
        $timestamped = Join-Path $scratch 'fixture-rfc3161.exe'
        $beforeNetwork = [DateTime]::UtcNow
        $row.addDiagnostic = Invoke-ProbeTool $ossl.FullName @('add','-h','sha256','-ts',$row.url,'-HTTPS-CAfile',$ca,'-verbose','-in',$fixture,'-out',$timestamped)
        if ($row.addDiagnostic.exitCode -ne 0) { throw 'osslsigncode_add_failed' }
        $afterNetwork = [DateTime]::UtcNow
        if ($row.addDiagnostic.stdout -match 'verification was skipped' -or $row.addDiagnostic.stderr -match 'verification was skipped') { throw 'tls_verification_skipped' }
        $row.afterTimestampSha256 = (Get-FileHash -LiteralPath $timestamped -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($row.afterTimestampSha256 -ceq $report.fixture.beforeTimestampSha256) { throw 'file_hash_not_changed' }
        $cms = Get-EmbeddedCms $timestamped
        $newPrimary = Get-PrimaryDescription $cms
        Assert-SamePrimary $report.fixture.primary $newPrimary
        $row.primaryUnchanged=$true
        $row.primary=$newPrimary
        $sig = Get-AuthenticodeSignature -LiteralPath $timestamped
        $row.windowsStatus=[string]$sig.Status
        if ($sig.Status -ne 'Valid' -or $null -eq $sig.TimeStamperCertificate -or
            (Get-PublicCertHash $sig.SignerCertificate) -cne $report.fixture.primary.signerSha256) {
            throw 'windows_signature_timestamp_or_identity_invalid'
        }
        $row.signtoolVerify = Invoke-ProbeTool $signTool.FullName @('verify','/pa','/all','/v','/tw',$timestamped)
        if ($row.signtoolVerify.exitCode -ne 0) { throw 'signtool_timestamp_verification_failed_or_warning' }
        $attrs = @($cms.SignerInfos[0].UnsignedAttributes | Where-Object { $_.Oid.Value -ceq '1.3.6.1.4.1.311.3.3.1' })
        if ($attrs.Count -ne 1 -or $attrs[0].Values.Count -ne 1) { throw 'rfc3161_attribute_missing_or_ambiguous' }
        $token=$null; $consumed=0
        $raw=$attrs[0].Values[0].RawData
        if (-not [Security.Cryptography.Pkcs.Rfc3161TimestampToken]::TryDecode([ReadOnlyMemory[byte]]::new($raw),[ref]$token,[ref]$consumed) -or $consumed -ne $raw.Length) {
            throw 'rfc3161_embedded_token_invalid'
        }
        $tsaCert=$null
        if (-not $token.VerifySignatureForSignerInfo($cms.SignerInfos[0],[ref]$tsaCert,$token.AsSignedCms().Certificates)) { throw 'rfc3161_not_bound_to_primary' }
        if ($token.TokenInfo.HashAlgorithmId.Value -cne '2.16.840.1.101.3.4.2.1') { throw 'rfc3161_digest_not_sha256' }
        if ($token.TokenInfo.Timestamp.UtcDateTime -lt $beforeNetwork.AddSeconds(-5) -or
            $token.TokenInfo.Timestamp.UtcDateTime -gt $afterNetwork.AddSeconds(5)) { throw 'rfc3161_time_outside_request_interval' }
        $row.tsa = Test-TsaChain $token
        if (-not $row.tsa.valid) { throw 'tsa_chain_or_revocation_not_valid_under_original_roots' }
        $row.tokenBoundToPrimary=$true
        $row.rfc3161Sha256=$true
        $row.timestampSignatureAdded=$true
        # Meaningful integrity negative: flip a byte in the first non-empty section.
        $tampered=Join-Path $scratch 'fixture-tampered.exe'
        $bytes=[IO.File]::ReadAllBytes($timestamped)
        $pe=[BitConverter]::ToInt32($bytes,60)
        $sectionTable=$pe+24+[BitConverter]::ToUInt16($bytes,$pe+20)
        $sectionCount=[BitConverter]::ToUInt16($bytes,$pe+6)
        $offset=0
        for($i=0;$i -lt $sectionCount;$i++){
            $s=$sectionTable+40*$i
            $size=[BitConverter]::ToUInt32($bytes,$s+16)
            $start=[BitConverter]::ToUInt32($bytes,$s+20)
            if($size -ge 32 -and $start -ge $sectionTable+40*$sectionCount -and [long]$start+$size -le $bytes.Length){
                $offset=[int]$start+16;break
            }
        }
        if($offset -eq 0){throw 'tamper_test_section_missing'}
        $bytes[$offset]=$bytes[$offset] -bxor 1
        [IO.File]::WriteAllBytes($tampered,$bytes)
        $badSig=Get-AuthenticodeSignature -LiteralPath $tampered
        $badVerify=Invoke-ProbeTool $signTool.FullName @('verify','/pa','/all','/v','/tw',$tampered)
        $row.integrityNegative=[ordered]@{windowsStatus=[string]$badSig.Status;signtoolExitCode=$badVerify.exitCode;rejected=($badSig.Status -ne 'Valid' -and $badVerify.exitCode -ne 0)}
        if(-not $row.integrityNegative.rejected){throw 'modified_fixture_not_rejected'}
        $row.technicalPass=$true
        $report.functionalTimestampPass=$true
    } catch {
        $msg=[string]$_.Exception.Message
        $row.errorCode=if($msg -match '^[a-z0-9_]+$'){$msg}else{'positive_exception_details_withheld'}
        $row.errorType=$_.Exception.GetType().Name
    }
    $report.positive=$row
} catch {
    $msg=[string]$_.Exception.Message
    $report.environmentErrorCode=if($msg -match '^[a-z0-9_]+$'){$msg}else{'environment_exception_details_withheld'}
    $report.environmentErrorType=$_.Exception.GetType().Name
} finally {
    $report.rootStoresUnchanged=(@(Compare-Object $rootsBefore @(Get-RootSnapshot)).Count -eq 0)
    $report.sourceFixtureUnchanged=($null -ne $fixtureSource -and (Get-FileHash -LiteralPath $fixtureSource -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $sourceHash)
    $report.secureIntegrationPass=($report.functionalTimestampPass -and $report.tlsPeerValidationProven -and $report.tlsHostnameValidationProven -and $report.rootStoresUnchanged -and $report.sourceFixtureUnchanged)
    $report.decision=if($report.secureIntegrationPass){'TECHNICAL_PROOF_ONLY_NO_OPERATIONAL_APPROVAL'}else{'NO_GO_SECURE_INTEGRATION'}
    Write-Host 'GPUBNB_OSSLSIGNCODE_JSON_BEGIN'
    $report | ConvertTo-Json -Depth 16 | Write-Host
    Write-Host 'GPUBNB_OSSLSIGNCODE_JSON_END'
    Remove-Item -LiteralPath $scratch -Recurse -Force
}
if (-not $report.secureIntegrationPass) { exit 1 }
