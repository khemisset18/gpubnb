param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$thumbprint = "$env:GPUBNB_CODESIGN_THUMBPRINT".Replace(' ', '').ToUpperInvariant()
$timestampUrl = "$env:GPUBNB_CODESIGN_TIMESTAMP_URL".Trim()

if ([string]::IsNullOrWhiteSpace($thumbprint)) {
    throw 'codesign_thumbprint_missing_on_signing_runner'
}
if ([string]::IsNullOrWhiteSpace($timestampUrl)) {
    throw 'codesign_timestamp_url_missing_on_signing_runner'
}
if (-not $Path -or $Path.Count -eq 0) {
    throw 'codesign_paths_missing'
}

$certificate = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Thumbprint.Replace(' ', '').ToUpperInvariant() -eq $thumbprint } |
    Select-Object -First 1
if (-not $certificate) {
    throw "codesign_certificate_not_found:$thumbprint"
}
if (-not $certificate.HasPrivateKey) {
    throw 'codesign_private_key_unavailable'
}
if ($certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -le (Get-Date)) {
    throw 'codesign_certificate_not_currently_valid'
}

$signTool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
if (-not $signTool) {
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $candidate = Get-ChildItem $kits -Filter signtool.exe -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($candidate) { $signTool = $candidate.FullName }
}
if (-not $signTool) {
    throw 'codesign_signtool_not_found'
}

foreach ($item in $Path) {
    if (-not (Test-Path $item -PathType Leaf)) {
        throw "codesign_path_missing:$item"
    }
    & $signTool sign /sha1 $thumbprint /fd SHA256 /tr $timestampUrl /td SHA256 /v $item
    if ($LASTEXITCODE -ne 0) {
        throw "codesign_failed:$item"
    }
}

& "$PSScriptRoot/verify-windows-authenticode.ps1" -Path $Path -Required
