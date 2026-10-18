#Requires -Version 5.1
# Read only. Never executes, signs, installs or modifies any inspected binary.
[CmdletBinding()]
param([string]$PackageDirectory,[string]$ManifestPath,[string]$ExpectedCommit,[switch]$InventoryOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 required' }
$checks = @()
function Assert-Check([string]$Name,[bool]$Ok,[string]$Detail) {
 $script:checks += [pscustomobject]@{name=$Name;pass=$Ok;detail=$Detail}
}
$names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe','gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
try {
 $gpu = & nvidia-smi --query-gpu=name,uuid,driver_version --format=csv,noheader 2>&1 | Out-String
 Assert-Check 'GTX1650-NVIDIA-driver' ($LASTEXITCODE -eq 0 -and $gpu -match 'GTX 1650') $gpu.Trim()
} catch { Assert-Check 'GTX1650-NVIDIA-driver' $false $_.Exception.Message }
try {
 $idd = @(Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object { $_.FriendlyName -match 'GPUbnb|IddCx' })
 Assert-Check 'IddCx-devices-present' ($idd.Count -gt 0) ('count='+$idd.Count)
} catch { Assert-Check 'IddCx-devices-present' $false $_.Exception.Message }
try {
 $certs = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -match 'LOCAL PHYSICAL TEST ONLY' })
 $valid = $certs.Count -eq 1 -and $certs[0].HasPrivateKey -and $certs[0].NotBefore -le (Get-Date) -and $certs[0].NotAfter -gt (Get-Date).AddDays(1) -and ($certs[0].EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3')
 $desc = if($certs.Count -eq 1) { 'expires='+$certs[0].NotAfter.ToUniversalTime().ToString('o')+' SHA256='+$certs[0].GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256) }else{'cert count='+$certs.Count}
 Assert-Check 'local-private-test-code-signing-certificate' $valid $desc
} catch { Assert-Check 'local-private-test-code-signing-certificate' $false $_.Exception.Message }
try { $users=@(Get-LocalUser); Assert-Check 'renter-account-manual-SID-review-required' $false ('users='+$users.Count+'; distinct WTS SID not automatically proven') } catch { Assert-Check 'renter-account-manual-SID-review-required' $false $_.Exception.Message }
if (-not $InventoryOnly) {
 if(-not $PackageDirectory -or -not $ManifestPath -or $ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'PackageDirectory, ManifestPath, exact ExpectedCommit required' }
 $m = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
 Assert-Check 'manifest-commit' ([string]$m.sourceCommit -ceq $ExpectedCommit) ([string]$m.sourceCommit)
 foreach($n in $names) {
  $path=Join-Path $PackageDirectory $n
  $entries=@($m.files | Where-Object { $_.name -ceq $n })
  if(-not (Test-Path -LiteralPath $path -PathType Leaf) -or $entries.Count -ne 1) { Assert-Check $n $false 'file or unique manifest entry missing';continue }
  $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  $data=[IO.File]::ReadAllBytes($path)
  $x64=$false
  if($data.Length -ge 512 -and [BitConverter]::ToUInt16($data,0) -eq 0x5A4D) {
   $offset=[BitConverter]::ToInt32($data,0x3c)
   if($offset -ge 0 -and $offset+26 -lt $data.Length) {
    $x64=[BitConverter]::ToUInt32($data,$offset) -eq 0x4550 -and [BitConverter]::ToUInt16($data,$offset+4) -eq 0x8664 -and [BitConverter]::ToUInt16($data,$offset+24) -eq 0x20b
   }
  }
  $sig=Get-AuthenticodeSignature -LiteralPath $path
  $pin=if($sig.SignerCertificate){$sig.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()}else{''}
  $ok=$x64 -and $hash -ceq [string]$entries[0].sha256 -and $sig.Status -eq 'Valid' -and $pin -ceq [string]$m.publisherSha256
  Assert-Check $n $ok ('sha256='+$hash+' amd64='+$x64+' signature='+$sig.Status+' signerSHA256='+$pin)
 }
}
$checks | ConvertTo-Json -Depth 5
if(@($checks | Where-Object { -not $_.pass }).Count -gt 0){exit 1}
