param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path,

    [switch]$Required,

    [switch]$RequireTimestamp,

    [string]$ExpectedSignerSha256
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Path -or $Path.Count -eq 0) {
    throw 'authenticode_paths_missing'
}
if ($PSBoundParameters.ContainsKey('ExpectedSignerSha256')) {
    $ExpectedSignerSha256 = $ExpectedSignerSha256.Replace(' ', '').ToLowerInvariant()
    if ($ExpectedSignerSha256 -notmatch '^[0-9a-f]{64}$') {
        throw 'authenticode_expected_signer_sha256_invalid'
    }
}

$results = @()
foreach ($item in $Path) {
    if (-not (Test-Path -LiteralPath $item -PathType Leaf)) {
        throw "authenticode_path_missing:$item"
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $item
    $signed = $null -ne $signature.SignerCertificate
    $valid = $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid

    # An unsigned development candidate is permitted only when signing is not
    # required. A file that *does* contain a signature must always validate:
    # accepting a present-but-broken signature is worse than explicitly knowing
    # that a pre-qualification candidate is unsigned.
    if (($signed -and -not $valid) -or
        (-not $signed -and $signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned)) {
        throw "authenticode_present_but_invalid:${item}:$($signature.Status)"
    }
    if ($Required -and -not $signed) {
        throw "authenticode_required_but_missing:$item"
    }

    $signerSha256 = $null
    if ($signed) {
        $signerSha256 = $signature.SignerCertificate.GetCertHashString(
            [System.Security.Cryptography.HashAlgorithmName]::SHA256
        ).ToLowerInvariant()
    }
    if ($ExpectedSignerSha256 -and $signerSha256 -cne $ExpectedSignerSha256) {
        throw "authenticode_unapproved_signer:$item"
    }

    $timestamped = $null -ne $signature.TimeStamperCertificate
    if ($RequireTimestamp -and -not $timestamped) {
        throw "authenticode_timestamp_required_but_missing:$item"
    }

    $results += [ordered]@{
        path = $item
        signed = $signed
        valid = $valid
        status = [string]$signature.Status
        signerSubject = if ($signed) { $signature.SignerCertificate.Subject } else { $null }
        signerThumbprint = if ($signed) { $signature.SignerCertificate.Thumbprint } else { $null }
        signerCertificateSha256 = $signerSha256
        timestamped = $timestamped
        timestampSignerSubject = if ($timestamped) { $signature.TimeStamperCertificate.Subject } else { $null }
        certificateNotAfter = if ($signed) { $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString('o') } else { $null }
    }
}

$results | ConvertTo-Json -Depth 6
