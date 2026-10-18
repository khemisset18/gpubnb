param(
    [Parameter(Mandatory = $true)]
    [string]$FrontendOrigin,
    [Parameter(Mandatory = $true)]
    [string]$ApiOrigin,
    [Parameter(Mandatory = $true)]
    [string]$GatewayOrigin,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedReleaseCommit,
    [string]$OutputPath = "",
    [switch]$PrivateSameOrigin
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$startedAt = [DateTime]::UtcNow
$checks = New-Object System.Collections.Generic.List[object]

function Add-Check {
    param([string]$Name, [bool]$Passed, [string]$Detail)
    $checks.Add([pscustomobject]@{ name = $Name; passed = $Passed; detail = $Detail }) | Out-Null
    $prefix = if ($Passed) { '[PASS]' } else { '[FAIL]' }
    Write-Host "$prefix $Name - $Detail"
}

function Normalize-PublicOrigin {
    param([string]$Name, [string]$Value)
    try { $uri = [Uri]$Value } catch { throw "$Name is not a valid URL" }
    if (-not $uri.IsAbsoluteUri) { throw "$Name must be an absolute URL" }
    if ($uri.Scheme -ne 'https') { throw "$Name must use HTTPS for final physical qualification" }
    if (-not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw "$Name must be an origin only (no credentials, query or fragment)"
    }
    if ($uri.AbsolutePath -ne '/') { throw "$Name must be an origin only (no path)" }
    return $uri.GetLeftPart([System.UriPartial]::Authority)
}

function Get-Public {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -Uri $Url -Method Get -MaximumRedirection 5 -TimeoutSec 20
        return [pscustomobject]@{
            ok = ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
            status = [int]$response.StatusCode
            body = [string]$response.Content
        }
    } catch {
        $status = 0
        try { $status = [int]$_.Exception.Response.StatusCode.value__ } catch {}
        return [pscustomobject]@{ ok = $false; status = $status; body = '' }
    }
}

function Get-ReleaseCommit {
    param($Response)
    if ($null -eq $Response -or -not $Response.ok -or $Response.status -ne 200) { return $null }
    try { $payload = $Response.body | ConvertFrom-Json } catch { return $null }
    $commit = [string]$payload.commit
    if ($commit -notmatch '^[0-9a-fA-F]{40}$') { return $null }
    return $commit.ToLowerInvariant()
}

function Test-GatewayWebSocket {
    param([string]$Origin)
    $wsUrl = (($Origin -replace '^https://', 'wss://').TrimEnd('/')) + '/ws-health'
    $client = [System.Net.WebSockets.ClientWebSocket]::new()
    $cts = [System.Threading.CancellationTokenSource]::new()
    $stream = [System.IO.MemoryStream]::new()
    try {
        $cts.CancelAfter(20000)
        $client.ConnectAsync([Uri]$wsUrl, $cts.Token).GetAwaiter().GetResult()
        $buffer = New-Object byte[] 1024
        do {
            $segment = [System.ArraySegment[byte]]::new($buffer)
            $received = $client.ReceiveAsync($segment, $cts.Token).GetAwaiter().GetResult()
            if ($received.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { break }
            if ($received.Count -gt 0) { $stream.Write($buffer, 0, $received.Count) }
        } while (-not $received.EndOfMessage)
        $message = [System.Text.Encoding]::UTF8.GetString($stream.ToArray())
        return [pscustomobject]@{
            ok = ($message -eq 'gpubnb-ws-ok')
            url = $wsUrl
            message = $message
            error = $null
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            url = $wsUrl
            message = ''
            error = $_.Exception.Message
        }
    } finally {
        $stream.Dispose()
        $cts.Dispose()
        $client.Dispose()
    }
}

try {
    $frontend = Normalize-PublicOrigin 'FrontendOrigin' $FrontendOrigin
    $api = Normalize-PublicOrigin 'ApiOrigin' $ApiOrigin
    $gateway = Normalize-PublicOrigin 'GatewayOrigin' $GatewayOrigin
} catch {
    Write-Error $_.Exception.Message
    exit 1
}

$expectedFull = $ExpectedReleaseCommit.Trim().ToLowerInvariant()
if ($expectedFull -notmatch '^[0-9a-f]{40}$') {
    Write-Error 'ExpectedReleaseCommit must be the exact 40-character Git SHA for physical qualification'
    exit 1
}

if ($PrivateSameOrigin) {
    Add-Check 'private frontend API gateway share exactly one HTTPS origin' ($frontend -ceq $api -and $api -ceq $gateway) "$frontend / $api / $gateway"
    $privateReady=Get-Public "$api/ready"
    $readyJson=$null;try{$readyJson=$privateReady.body|ConvertFrom-Json}catch{}
    Add-Check 'private API ready JSON' ($privateReady.status -eq 200 -and $null -ne $readyJson -and $readyJson.ok -eq $true) "HTTP $($privateReady.status)"
    $release=Get-ReleaseCommit (Get-Public "$api/release")
    Add-Check 'private exact API deployment identity' ($release -ceq $expectedFull) "expected=$expectedFull observed=$release"
    $config=Get-Public "$frontend/config.js"
    $runtimeCommit=[regex]::Match($config.body,'"releaseCommit"\s*:\s*"([0-9a-f]{40})"')
    $sameOrigin=$config.body.Contains('BEGIN_PRIVATE_HTTPS_SAME_ORIGIN') -and $config.body.Contains('window.location.origin')
    Add-Check 'private browser runtime exact release identity and same-origin routing' ($config.status -eq 200 -and $runtimeCommit.Success -and $runtimeCommit.Groups[1].Value -ceq $expectedFull -and $sameOrigin) 'runtime config.js must identify the full deployed SHA'
    $page=Get-Public "$frontend/stage3-windows-native.html"
    Add-Check 'private qualification entry page' ($page.status -eq 200 -and $page.body.Contains('id="stage3-start"')) "HTTP $($page.status)"
    $desktop=Get-Public "$frontend/windows-native-desktop.html"
    Add-Check 'decoded-frame continuity indicator is actually deployed' ($desktop.status -eq 200 -and $desktop.body.Contains('id="nativeDesktopContinuity"')) "HTTP $($desktop.status)"
    $anonymous=Get-Public "$api/qualification/windows-native/preflight"
    Add-Check 'unauthenticated preflight is refused' ($anonymous.status -eq 401 -or $anonymous.status -eq 403) "HTTP $($anonymous.status); HTML 200 is never accepted"
    $health=Test-GatewayWebSocket $gateway
    Add-Check 'private WSS health exact frame' $health.ok $health.url
    $passed=@($checks|Where-Object {-not $_.passed}).Count -eq 0
    $report=[ordered]@{kind='STAGE4_PRIVATE_PC2_READ_ONLY_PREFLIGHT';passed=$passed;checks=$checks;
        sourceCommit=$release;authenticatedBrowserPreflightStillRequired=$true;sessionStarted=$false;physicalTestPerformed=$false}
    $report|ConvertTo-Json -Depth 8
    if($OutputPath){$report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $OutputPath -Encoding UTF8}
    if(-not $passed){exit 1};exit 0
}

Add-Check 'public origins are HTTPS and origin-only' $true "frontend=$frontend api=$api gateway=$gateway"

$frontResponse = Get-Public "$frontend/"
Add-Check 'frontend public route' $frontResponse.ok $(if ($frontResponse.ok) { "HTTP $($frontResponse.status)" } else { "unreachable/HTTP $($frontResponse.status)" })

$sameOriginReady = Get-Public "$frontend/api/ready"
$sameOriginReadyOk = $sameOriginReady.ok -and $sameOriginReady.status -eq 200
Add-Check 'frontend same-origin /api proxy' $sameOriginReadyOk $(if ($sameOriginReadyOk) { 'HTTP 200' } else { "expected HTTP 200, got $($sameOriginReady.status)" })

$directApiReady = Get-Public "$api/ready"
$directApiReadyOk = $directApiReady.ok -and $directApiReady.status -eq 200
Add-Check 'direct API /ready' $directApiReadyOk $(if ($directApiReadyOk) { 'HTTP 200' } else { "expected HTTP 200, got $($directApiReady.status)" })

$directReleaseResponse = Get-Public "$api/release"
$directReleaseCommit = Get-ReleaseCommit $directReleaseResponse
$directReleaseOk = $null -ne $directReleaseCommit
Add-Check 'direct API release identity' $directReleaseOk $(if ($directReleaseOk) { $directReleaseCommit } else { "missing exact release SHA (HTTP $($directReleaseResponse.status))" })

$sameOriginReleaseResponse = Get-Public "$frontend/api/release"
$sameOriginReleaseCommit = Get-ReleaseCommit $sameOriginReleaseResponse
$sameOriginReleaseOk = $null -ne $sameOriginReleaseCommit
Add-Check 'same-origin API release identity' $sameOriginReleaseOk $(if ($sameOriginReleaseOk) { $sameOriginReleaseCommit } else { "missing exact release SHA through /api proxy (HTTP $($sameOriginReleaseResponse.status))" })

$apiReleaseAgreement = $directReleaseOk -and $sameOriginReleaseOk -and $directReleaseCommit -eq $sameOriginReleaseCommit
Add-Check 'direct and same-origin API target the same release' $apiReleaseAgreement $(if ($apiReleaseAgreement) { $directReleaseCommit } else { "direct=$directReleaseCommit proxied=$sameOriginReleaseCommit" })

if ($expectedFull -and $directReleaseOk -and $sameOriginReleaseOk) {
    $apiExpected = $directReleaseCommit -eq $expectedFull -and $sameOriginReleaseCommit -eq $expectedFull
    Add-Check 'expected API release commit' $apiExpected $(if ($apiExpected) { $expectedFull } else { "expected $expectedFull, direct=$directReleaseCommit proxied=$sameOriginReleaseCommit" })
}

$gatewayHealth = Test-GatewayWebSocket $gateway
$gatewayHealthOk = $gatewayHealth.ok
Add-Check 'workspace gateway WebSocket /ws-health' $gatewayHealthOk $(if ($gatewayHealthOk) { 'WSS upgrade + exact gpubnb-ws-ok frame' } else { "WSS probe failed: $($gatewayHealth.error)" })

$configResponse = Get-Public "$frontend/config.js"
$configOk = $configResponse.ok -and $configResponse.status -eq 200
Add-Check 'published config.js' $configOk $(if ($configOk) { 'HTTP 200' } else { "expected HTTP 200, got $($configResponse.status)" })

$publishedCommit = $null
$publishedGateway = $null
$publishedApiSameOrigin = $false
if ($configOk) {
    $publishedApiSameOrigin = $configResponse.body -match 'window\.GPUBNB_API_URL\s*=\s*window\.GPUBNB_API_URL\s*\|\|\s*"/api";'
    $gatewayMatch = [regex]::Match($configResponse.body, 'window\.GPUBNB_GATEWAY_URL\s*=\s*window\.GPUBNB_GATEWAY_URL\s*\|\|\s*"([^"]+)";')
    if ($gatewayMatch.Success) { $publishedGateway = $gatewayMatch.Groups[1].Value }
    $commitMatch = [regex]::Match($configResponse.body, '"commit"\s*:\s*"([0-9a-fA-F]{7})"')
    if ($commitMatch.Success) { $publishedCommit = $commitMatch.Groups[1].Value.ToLowerInvariant() }
}

Add-Check 'published browser API is same-origin /api' $publishedApiSameOrigin $(if ($publishedApiSameOrigin) { '/api' } else { 'published config does not expose the required same-origin /api base' })
$gatewayMatchesConfig = $null -ne $publishedGateway -and $publishedGateway.TrimEnd('/') -ieq $gateway.TrimEnd('/')
Add-Check 'published gateway origin matches qualification target' $gatewayMatchesConfig $(if ($gatewayMatchesConfig) { $publishedGateway } else { "expected $gateway, published $publishedGateway" })
$commitPresent = $null -ne $publishedCommit
Add-Check 'published frontend build commit' $commitPresent $(if ($commitPresent) { $publishedCommit } else { 'missing 7-character hosted build commit in config.js' })

if ($expectedFull -and $commitPresent) {
    $expectedShort = $expectedFull.Substring(0, 7)
    $frontendMatch = $publishedCommit -eq $expectedShort
    Add-Check 'expected frontend release commit' $frontendMatch $(if ($frontendMatch) { $expectedShort } else { "expected $expectedShort, published $publishedCommit" })
}

$frontendApiAgreement = $commitPresent -and $directReleaseOk -and $directReleaseCommit.StartsWith($publishedCommit)
Add-Check 'frontend and API release identities agree' $frontendApiAgreement $(if ($frontendApiAgreement) { "$publishedCommit -> $directReleaseCommit" } else { "frontend=$publishedCommit api=$directReleaseCommit" })

$failed = @($checks | Where-Object { -not $_.passed })
$result = [ordered]@{
    schemaVersion = 2
    kind = 'gpubnb-physical-qualification-pc-b-preflight'
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    passed = ($failed.Count -eq 0)
    origins = [ordered]@{
        frontend = $frontend
        api = $api
        gateway = $gateway
    }
    frontend = [ordered]@{
        publishedCommit = $publishedCommit
        expectedReleaseCommit = if ($ExpectedReleaseCommit) { $expectedFull } else { $null }
        publishedGatewayOrigin = $publishedGateway
        apiBase = if ($publishedApiSameOrigin) { '/api' } else { $null }
    }
    api = [ordered]@{
        directReleaseCommit = $directReleaseCommit
        sameOriginReleaseCommit = $sameOriginReleaseCommit
    }
    gateway = [ordered]@{
        websocketHealthPassed = $gatewayHealthOk
        healthPath = '/ws-health'
    }
    checks = $checks
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $stamp = $startedAt.ToString('yyyyMMddTHHmmssZ')
    $evidenceRoot = Join-Path $repoRoot 'qualification-evidence'
    New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
    $OutputPath = Join-Path $evidenceRoot "pc-b-preflight-$stamp.json"
} else {
    $parent = Split-Path -Parent $OutputPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
}
$result | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Host "Evidence: $OutputPath"

if ($failed.Count -gt 0) {
    Write-Error "PC B preflight FAILED ($($failed.Count) check(s)). Do not start the physical rental."
    exit 1
}
Write-Host 'PC B public-path preflight PASSED. Keep these exact public origins/build identity unchanged for the clean run.'
exit 0
