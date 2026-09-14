param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path,

    [switch]$Required
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Path -or $Path.Count -eq 0) {
    throw 'authenticode_paths_missing'
}

$results = @()
foreach ($item in $Path) {
    if (-not (Test-Path $item -PathType Leaf)) {
        throw "authenticode_path_missing:$item"
    }

    $signature = Get-AuthenticodeSignature -FilePath $item
    $signed = $null -ne $signature.SignerCertificate
    $valid = $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid

    # An unsigned development candidate is permitted only when signing is not
    # required. A file that *does* contain a signature must always validate:
    # accepting a present-but-broken signature is worse than explicitly knowing
    # that a pre-qualification candidate is unsigned.
    if ($signed -and -not $valid) {
        throw "authenticode_present_but_invalid:$item:$($signature.Status)"
    }
    if ($Required -and -not $signed) {
        throw "authenticode_required_but_missing:$item"
    }

    $results += [ordered]@{
        path = $item
        signed = $signed
        valid = $valid
        status = [string]$signature.Status
        signerSubject = if ($signed) { $signature.SignerCertificate.Subject } else { $null }
        signerThumbprint = if ($signed) { $signature.SignerCertificate.Thumbprint } else { $null }
        certificateNotAfter = if ($signed) { $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString('o') } else { $null }
    }
}

$results | ConvertTo-Json -Depth 6
