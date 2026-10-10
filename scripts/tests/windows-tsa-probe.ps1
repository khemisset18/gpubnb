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
function Invoke-SignTool([string[]]$Arguments, [string]$LogName) {
    $out = Join-Path $scratch "$LogName.stdout"
    $err = Join-Path $scratch "$LogName.stderr"
    $p = Start-Process -FilePath $signTool.FullName -ArgumentList $Arguments -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
    if (-not $p.WaitForExit(60000)) {
        $p.Kill()
        $p.WaitForExit()
        throw 'signtool_probe_timeout'
    }
    $p.WaitForExit()
    $script:signToolDiagnostics[$LogName] = [ordered]@{
        exitCode = $p.ExitCode
        # Controlled Microsoft tool, public disposable fixture and public URL only.
        stdout = ((Get-Content -LiteralPath $out -ErrorAction Stop | Select-Object -First 30) -join "`n")
        stderr = ((Get-Content -LiteralPath $err -ErrorAction Stop | Select-Object -First 30) -join "`n")
    }
    return $p.ExitCode
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

$scratch = Join-Path $env:RUNNER_TEMP ('gpubnb-tsa-probe-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $scratch)
$results = @()
$signToolDiagnostics = @{}
$report = [ordered]@{ schemaVersion = 1; probe = 'windows-isolated-public-fixture-only'; codeSigningPerformed = $false; rootsImported = $false; providers = @(); gpuBnbCandidateSigned = $false; pc1CompatibilityProven = $false }
try {
    $signTool = Get-ChildItem -LiteralPath (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin') -Filter signtool.exe -File -Recurse |
        Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } | Sort-Object FullName -Descending | Select-Object -First 1
    if ($null -eq $signTool) { throw 'preinstalled_signtool_missing' }
    $toolSignature = Get-AuthenticodeSignature -LiteralPath $signTool.FullName
    if ($toolSignature.Status -ne 'Valid' -or $toolSignature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation(?:,|$)') { throw 'preinstalled_signtool_not_trusted_microsoft' }
    $report.signToolPath = $signTool.FullName
    $report.signToolVersion = $signTool.VersionInfo.FileVersion
    $report.windowsVersion = [Environment]::OSVersion.Version.ToString()
    $report.collectedAtUtc = [DateTime]::UtcNow.ToString('o')
    $fixture = $null
    $paths = @((Join-Path $PSHOME 'pwsh.exe'), $signTool.FullName, (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'))
    foreach ($path in $paths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $sig = Get-AuthenticodeSignature -LiteralPath $path
        $now = [DateTime]::UtcNow
        if ($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or
            $sig.SignerCertificate.NotBefore.ToUniversalTime() -gt $now -or
            $sig.SignerCertificate.NotAfter.ToUniversalTime() -le $now) { continue }
        try {
            $cms = Get-EmbeddedCms $path
            if ($cms.SignerInfos.Count -ne 1 -or $cms.SignerInfos[0].DigestAlgorithm.Value -cne '2.16.840.1.101.3.4.2.1') { continue }
            $copy = Join-Path $scratch 'fixture.exe'
            Copy-Item -LiteralPath $path -Destination $copy
            if ((Invoke-SignTool @('remove', '/u', $copy) 'fixture-remove-timestamp') -ne 0) { continue }
            $after = Get-AuthenticodeSignature -LiteralPath $copy
            if ($after.Status -ne 'Valid' -or $null -ne $after.TimeStamperCertificate -or
                (Get-PublicCertHash $after.SignerCertificate) -cne (Get-PublicCertHash $sig.SignerCertificate)) { continue }
            if ((Invoke-SignTool @('verify', '/pa', '/all', '/v', $copy) 'fixture-verify') -ne 0) { continue }
            $fixture = $copy
            $report.fixture = [ordered]@{ sourcePath = $path; sourceSha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash; signerCertificateSha256 = Get-PublicCertHash $after.SignerCertificate; signerNotAfterUtc = $after.SignerCertificate.NotAfter.ToUniversalTime().ToString('o'); primaryDigest = 'SHA256'; fixtureNeverExecuted = $true }
            break
        } catch { continue }
    }
    if ($null -eq $fixture) { throw 'no_currently_valid_existing_sha256_embedded_fixture' }
    $providers = @(
        @{ name = 'FreeTSA'; url = 'https://freetsa.org/tsr'; terms = 'documented-free-existing-windows-trust-unproven' },
        @{ name = 'Codegic'; url = 'https://pki.codegic.com/codegic-service/timestamp'; terms = 'documented-free-demo-only' },
        @{ name = 'AI-MODA'; url = 'https://rfc3161.ai.moda/'; terms = 'cost-and-service-conditions-unconfirmed' },
        @{ name = 'DigiCert-HTTPS'; url = 'https://timestamp.digicert.com/'; terms = 'https-endpoint-support-and-terms-unconfirmed' },
        @{ name = 'Sectigo-HTTPS'; url = 'https://timestamp.sectigo.com/'; terms = 'https-endpoint-support-and-terms-unconfirmed' },
        @{ name = 'SSLcom-HTTPS'; url = 'https://ts.ssl.com/'; terms = 'https-endpoint-support-and-terms-unconfirmed' }
    )
    foreach ($provider in $providers) {
        $row = [ordered]@{ name = $provider.name; requestedHttpsUrl = $provider.url; terms = $provider.terms; approved = $false; directRfc3161Sha256 = $false; signtoolTimestampExitCode = $null; signtoolVerifyExitCode = $null; technicalPass = $false; errorType = $null; errorCode = $null }
        $handler = [System.Net.Http.HttpClientHandler]::new()
        $handler.AllowAutoRedirect = $false
        $handler.UseDefaultCredentials = $false
        $client = [System.Net.Http.HttpClient]::new($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(25)
        try {
            # Public random probe data only. No GPUbnb digest, file, identity or key.
            $digest = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
            $nonce = [System.ReadOnlyMemory[byte]]::new([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(16))
            $request = [System.Security.Cryptography.Pkcs.Rfc3161TimestampRequest]::CreateFromHash([System.ReadOnlyMemory[byte]]::new($digest), [System.Security.Cryptography.HashAlgorithmName]::SHA256, $null, $nonce, $true, $null)
            $content = [System.Net.Http.ByteArrayContent]::new($request.Encode())
            $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new('application/timestamp-query')
            $response = $client.PostAsync($provider.url, $content).GetAwaiter().GetResult()
            $row.httpStatus = [int]$response.StatusCode
            $row.responseContentType = [string]$response.Content.Headers.ContentType
            if (-not $response.IsSuccessStatusCode) { throw 'rfc3161_https_post_not_successful_no_redirect_followed' }
            if ($response.Content.Headers.ContentType.MediaType -cne 'application/timestamp-reply') { throw 'rfc3161_response_content_type' }
            $raw = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
            if ($raw.Length -gt 1048576) { throw 'rfc3161_response_too_large' }
            $consumed = 0
            $token = $request.ProcessResponse([System.ReadOnlyMemory[byte]]::new($raw), [ref]$consumed)
            if ($consumed -ne $raw.Length -or $token.TokenInfo.HashAlgorithmId.Value -cne '2.16.840.1.101.3.4.2.1') { throw 'rfc3161_response_digest_or_length' }
            $row.directRfc3161Sha256 = $true
            $row.randomProbeChain = Test-TsaChain $token
            # Reject an unsuitable chain before modifying even a disposable fixture.
            if (-not $row.randomProbeChain.valid) { throw 'tsa_chain_not_valid_under_original_windows_roots' }
            $file = Join-Path $scratch ($provider.name + '.exe')
            Copy-Item -LiteralPath $fixture -Destination $file
            $row.signtoolTimestampExitCode = Invoke-SignTool @('timestamp', '/tr', $provider.url, '/td', 'SHA256', '/tp', '0', '/v', $file) ($provider.name + '-timestamp')
            $row.timestampDiagnostic = $signToolDiagnostics[$provider.name + '-timestamp']
            if ($row.signtoolTimestampExitCode -ne 0) { throw 'signtool_timestamp_failed' }
            $row.signtoolVerifyExitCode = Invoke-SignTool @('verify', '/pa', '/all', '/v', '/tw', $file) ($provider.name + '-verify')
            $row.verifyDiagnostic = $signToolDiagnostics[$provider.name + '-verify']
            if ($row.signtoolVerifyExitCode -ne 0) { throw 'signtool_verification_failed_or_warning' }
            $sig = Get-AuthenticodeSignature -LiteralPath $file
            if ($sig.Status -ne 'Valid' -or $null -eq $sig.TimeStamperCertificate -or (Get-PublicCertHash $sig.SignerCertificate) -cne $report.fixture.signerCertificateSha256) { throw 'fixture_authenticode_or_signer_changed' }
            $cms = Get-EmbeddedCms $file
            $attrs = @($cms.SignerInfos[0].UnsignedAttributes | Where-Object { $_.Oid.Value -ceq '1.3.6.1.4.1.311.3.3.1' })
            if ($attrs.Count -ne 1 -or $attrs[0].Values.Count -ne 1) { throw 'embedded_rfc3161_token_missing_or_ambiguous' }
            $embedded = $null
            $consumed = 0
            $bytes = $attrs[0].Values[0].RawData
            if (-not [System.Security.Cryptography.Pkcs.Rfc3161TimestampToken]::TryDecode([System.ReadOnlyMemory[byte]]::new($bytes), [ref]$embedded, [ref]$consumed) -or $consumed -ne $bytes.Length) { throw 'embedded_rfc3161_token_invalid' }
            $tsaCert = $null
            if (-not $embedded.VerifySignatureForSignerInfo($cms.SignerInfos[0], [ref]$tsaCert, $embedded.AsSignedCms().Certificates)) { throw 'embedded_timestamp_not_bound_to_primary_signature' }
            if ($embedded.TokenInfo.HashAlgorithmId.Value -cne '2.16.840.1.101.3.4.2.1') { throw 'embedded_timestamp_digest_not_sha256' }
            $row.embeddedTokenChain = Test-TsaChain $embedded
            if (-not $row.embeddedTokenChain.valid) { throw 'embedded_tsa_chain_invalid' }
            $row.fixtureAuthenticodeStatus = [string]$sig.Status
            $row.technicalPass = $true
        } catch {
            $row.errorType = $_.Exception.GetType().Name
            $row.innerErrorType = if ($null -ne $_.Exception.InnerException) { $_.Exception.InnerException.GetType().Name } else { $null }
            # Only static errors or type names are emitted; no URL/headers/body/credentials.
            $msg = [string]$_.Exception.Message
            $row.errorCode = if ($msg -match '^[a-z0-9_]+$') { $msg } else { 'probe_exception_details_withheld' }
        } finally { $client.Dispose(); $handler.Dispose() }
        $results += [pscustomobject]$row
        if (@(Compare-Object $rootsBefore @(Get-RootSnapshot)).Count -ne 0) { throw 'windows_root_store_changed_probe_invalid' }
    }
} catch {
    $report.environmentErrorType = $_.Exception.GetType().Name
    $report.environmentErrorCode = if ($_.Exception.Message -match '^[a-z0-9_]+$') { $_.Exception.Message } else { 'environment_exception_details_withheld' }
} finally {
    $report.providers = @($results)
    $report.rootStoresUnchanged = (@(Compare-Object $rootsBefore @(Get-RootSnapshot)).Count -eq 0)
    $report.providerApprovalGranted = $false
    $report.compatibilityWithGpuBnbCertificateOrPc1Proven = $false
    Write-Host 'GPUBNB_TSA_PROBE_JSON_BEGIN'
    $report | ConvertTo-Json -Depth 12 | Write-Host
    Write-Host 'GPUBNB_TSA_PROBE_JSON_END'
    # Only the GUID-named directory created by this probe is removed.
    Remove-Item -LiteralPath $scratch -Recurse -Force
}
if ($report.Contains('environmentErrorCode') -or -not $report.rootStoresUnchanged) { exit 1 }
# A completed measurement is not a provider approval or a release GO.
