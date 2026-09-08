param(
    [Parameter(Mandatory = $true)]
    [string]$FrontendOrigin,
    [Parameter(Mandatory = $true)]
    [string]$ApiOrigin,
    [Parameter(Mandatory = $true)]
    [string]$GatewayOrigin,
    [string]$ExpectedReleaseCommit = "",
    [string]$OutputPath = ""
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

try {
    $frontend = Normalize-PublicOrigin 'FrontendOrigin' $FrontendOrigin
    $api = Normalize-PublicOrigin 'ApiOrigin' $ApiOrigin
    $gateway = Normalize-PublicOrigin 'GatewayOrigin' $GatewayOrigin
} catch {
    Write-Error $_.Exception.Message
    exit 1
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

$gatewayHealth = Get-Public "$gateway/ws-health"
$gatewayHealthOk = $gatewayHealth.ok -and $gatewayHealth.status -eq 200 -and $gatewayHealth.body.Contains('gpubnb-ws-ok')
Add-Check 'workspace gateway /ws-health' $gatewayHealthOk $(if ($gatewayHealthOk) { 'HTTP 200 + gpubnb-ws-ok' } else { "gateway health failed (HTTP $($gatewayHealth.status))" })

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

if (-not [string]::IsNullOrWhiteSpace($ExpectedReleaseCommit) -and $commitPresent) {
    $expectedShort = $ExpectedReleaseCommit.Trim().ToLowerInvariant()
    if ($expectedShort.Length -gt 7) { $expectedShort = $expectedShort.Substring(0, 7) }
    $commitMatch = $publishedCommit -eq $expectedShort
    Add-Check 'expected frontend release commit' $commitMatch $(if ($commitMatch) { $expectedShort } else { "expected $expectedShort, published $publishedCommit" })
}

$failed = @($checks | Where-Object { -not $_.passed })
$result = [ordered]@{
    schemaVersion = 1
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
        expectedReleaseCommit = if ($ExpectedReleaseCommit) { $ExpectedReleaseCommit } else { $null }
        publishedGatewayOrigin = $publishedGateway
        apiBase = if ($publishedApiSameOrigin) { '/api' } else { $null }
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
