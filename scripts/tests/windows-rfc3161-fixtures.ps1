# Public fixture diagnostics only, no code signing or private key operations.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'khemisset18/gpubnb'){throw 'isolated_windows_required'}
function Roots { @('CurrentUser','LocalMachine')|ForEach-Object {$s=$_;Get-ChildItem -LiteralPath "Cert:\$s\Root"|ForEach-Object {"$s|$($_.Thumbprint)"}}|Sort-Object -Unique }
$before=@(Roots)
Add-Type -TypeDefinition @'
using System;
using System.Linq;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
public static class ExpiredPublicFixture {
    public static string Certificate;
    public static string Errors;
    public static string[] Statuses;
    public static string ErrorType;
    public static void Read() {
        using (var c=new TcpClient()) {
            try {
                if(!c.ConnectAsync("expired.badssl.com",443).Wait(12000)) throw new TimeoutException();
                using(var s=new SslStream(c.GetStream(),false,(sender,cert,chain,errors)=>{
                    Certificate=Convert.ToBase64String(cert.GetRawCertData());
                    Errors=errors.ToString();
                    Statuses=chain.ChainStatus.Select(x=>x.Status.ToString()).ToArray();
                    return errors==SslPolicyErrors.None;
                })) {
                    if(!s.AuthenticateAsClientAsync("expired.badssl.com").Wait(12000)) throw new TimeoutException();
                }
            } catch(Exception e){ErrorType=(e.InnerException??e).GetType().Name;}
        }
    }
}
'@
function PublicHttp([string]$Url,[string]$Method='GET') {
    $h=[Net.Http.HttpClientHandler]::new();$h.UseDefaultCredentials=$false;$h.UseProxy=$false;$h.AllowAutoRedirect=$false
    $client=[Net.Http.HttpClient]::new($h);$client.Timeout=[TimeSpan]::FromSeconds(15)
    $r=$null;$content=$null
    try{
        if($Method -ceq 'POST'){
            $content=[Net.Http.ByteArrayContent]::new([byte[]]@(0x30,0))
            $content.Headers.ContentType=[Net.Http.Headers.MediaTypeHeaderValue]::new('application/timestamp-query')
            $r=$client.PostAsync($Url,$content).GetAwaiter().GetResult()
        }else{$r=$client.GetAsync($Url).GetAwaiter().GetResult()}
        $b=$r.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        [ordered]@{url=$Url;method=$Method;status=[int]$r.StatusCode;contentType=[string]$r.Content.Headers.ContentType;length=$b.Length;firstBytesHex=[Convert]::ToHexString($b[0..([Math]::Min(15,$b.Length-1))]);sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($b)).ToLowerInvariant()}
    }catch{[ordered]@{url=$Url;method=$Method;errorType=$_.Exception.GetType().Name}}
    finally{if($r){$r.Dispose()};if($content){$content.Dispose()};$client.Dispose();$h.Dispose()}
}
[ExpiredPublicFixture]::Read()
if(-not [ExpiredPublicFixture]::Certificate){throw 'expired_fixture_public_certificate_missing'}
$cert=[Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String([ExpiredPublicFixture]::Certificate))
$cdp=@($cert.Extensions|Where-Object {$_.Oid.Value -ceq '2.5.29.31'}|ForEach-Object {$_.Format($true)}) -join [Environment]::NewLine
$urls=@([regex]::Matches($cdp,'https?://[^\s,]+')|ForEach-Object {$_.Value}|Sort-Object -Unique)
$crls=@(foreach($url in $urls){
    $u=[Uri]$url
    if($u.UserInfo -eq '' -and $u.IsDefaultPort -and $u.Host -match '(?i)(^|\.)(digicert\.com|comodoca\.com|sectigo\.com)$'){PublicHttp $url}
})
$rows=@(
    PublicHttp 'https://httpbingo.org/response-headers?Content-Type=application%2Ftimestamp-reply' 'POST'
    PublicHttp 'https://httpbingo.org/response-headers?Content-Type=application%2Ftimestamp-reply'
    PublicHttp 'https://httpbin.org/response-headers?Content-Type=application%2Ftimestamp-reply' 'POST'
    PublicHttp 'https://httpbin.org/response-headers?Content-Type=application%2Ftimestamp-reply'
)
$report=[ordered]@{
    schemaVersion=1;workflowCommit=$env:GITHUB_SHA;collectedAtUtc=[DateTime]::UtcNow.ToString('o')
    expired=[ordered]@{issuer=$cert.Issuer;notAfterUtc=$cert.NotAfter.ToUniversalTime().ToString('o');certificateSha256=$cert.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256);errors=[ExpiredPublicFixture]::Errors;statuses=[ExpiredPublicFixture]::Statuses;cdpUrls=$urls;crls=$crls}
    malformedResponses=$rows;rootStoresUnchanged=(@(Compare-Object $before @(Roots)).Count -eq 0)
    gpuBnbKeyUsed=$false;gpuBnbBinarySigned=$false;pc1OrPc2Accessed=$false;extraCostEuros=0
}
$cert.Dispose()
Write-Host 'GPUBNB_PUBLIC_FIXTURES_JSON_BEGIN'
$report|ConvertTo-Json -Depth 12|Write-Host
Write-Host 'GPUBNB_PUBLIC_FIXTURES_JSON_END'
if(-not $report.rootStoresUnchanged){throw 'root_store_changed'}
