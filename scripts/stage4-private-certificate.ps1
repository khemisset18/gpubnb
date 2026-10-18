#Requires -Version 5.1
# Inspect the REAL local certificate by exact public pin. Creation is opt-in;
# no trust store, Windows policy, driver, service or installed binary is changed.
[CmdletBinding(SupportsShouldProcess=$true,DefaultParameterSetName='Inspect')]
param(
    [Parameter(Mandatory=$true)][string]$ExpectedPublisherSha256,
    [Parameter(Mandatory=$true,ParameterSetName='Replacement')][switch]$CreateReplacement,
    [Parameter(Mandatory=$true,ParameterSetName='Replacement')][string]$OutputDirectory,
    [Parameter(ParameterSetName='Replacement')][ValidateRange(7,30)][int]$ValidityDays=14
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess){throw 'stage4_private_windows_x64_required'}
. (Join-Path $PSScriptRoot 'stage4-package-common.ps1')
if($ExpectedPublisherSha256 -cnotmatch '^[0-9a-f]{64}$' -or $ExpectedPublisherSha256 -match '^(.)\1{63}$'){
    throw 'stage4_real_publisher_pin_required'
}
$matches=@(Get-ChildItem Cert:\CurrentUser\My|Where-Object {
    $_.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -ceq $ExpectedPublisherSha256
})
if($matches.Count -gt 1){throw 'stage4_private_ambiguous_certificate'}
$existing=if($matches.Count -eq 1){$matches[0]}else{$null}
$status=Get-Stage4PrivateCertificateStatus -Certificate $existing -ExpectedPublisherSha256 $ExpectedPublisherSha256
if(-not $CreateReplacement){
    [ordered]@{mode='read_only';certificate=$status;certificateCreated=$false;trustChanged=$false;
        signingPerformed=$false;installationPerformed=$false} | ConvertTo-Json -Depth 6
    return
}
$target=Assert-Stage4NewOutput $OutputDirectory $PSScriptRoot
# Validate commands and paths before creating a key. Existing certificates remain.
[void](Get-Command New-SelfSignedCertificate -ErrorAction Stop)
[void](Get-Command Export-Certificate -ErrorAction Stop)
if(-not $PSCmdlet.ShouldProcess('Cert:\CurrentUser\My', "Create a nonexportable LOCAL PHYSICAL TEST ONLY signing key for $ValidityDays days and export only its PUBLIC certificate")){
    [ordered]@{mode='preview';certificate=$status;certificateCreated=$false;trustChanged=$false;
        signingPerformed=$false;installationPerformed=$false;outputDirectory=$target;validityDays=$ValidityDays} | ConvertTo-Json -Depth 6
    return
}
[void][IO.Directory]::CreateDirectory($target)
$marker=Join-Path $target 'INCOMPLETE-CERTIFICATE-PREPARATION.txt'
[IO.File]::WriteAllText($marker,'Preparation not complete. No trust or signing approval is implied.')
$created=$null
try {
    $subject='CN=GPUbnb LOCAL PHYSICAL TEST ONLY '+(Get-Date -Format 'yyyy-MM-dd')+' '+[guid]::NewGuid().ToString('N').Substring(0,8)
    $created=New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -FriendlyName $subject `
        -CertStoreLocation 'Cert:\CurrentUser\My' -Provider 'Microsoft Software Key Storage Provider' `
        -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyUsage DigitalSignature `
        -KeyExportPolicy NonExportable -NotBefore (Get-Date).AddMinutes(-5) -NotAfter (Get-Date).AddDays($ValidityDays)
    if(-not $created.HasPrivateKey){throw 'stage4_replacement_private_key_missing'}
    $pin=$created.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
    if($pin -ceq $ExpectedPublisherSha256){throw 'stage4_replacement_must_have_new_pin'}
    # Verify the actual CNG key policy, without attempting to export private bytes.
    $key=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($created)
    try {
        if($key -isnot [Security.Cryptography.RSACng] -or $key.KeySize -lt 3072 -or
            $key.Key.ExportPolicy -ne [Security.Cryptography.CngExportPolicies]::None){
            throw 'stage4_replacement_nonexportable_cng_key_required'
        }
    } finally {if($null -ne $key){$key.Dispose()}}
    $newStatus=Get-Stage4PrivateCertificateStatus -Certificate $created -ExpectedPublisherSha256 $pin
    if(-not $newStatus.codeSigningEku -or $created.SignatureAlgorithm.Value -cne '1.2.840.113549.1.1.11'){
        throw 'stage4_replacement_sha256_code_signing_required'
    }
    $cer=Join-Path $target 'stage4-private-public.cer'
    Export-Certificate -Cert $created -FilePath $cer -Type CERT -NoClobber | Out-Null
    if((Get-FileHash -LiteralPath $cer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin){throw 'stage4_replacement_public_export_hash_mismatch'}
    $public=[Security.Cryptography.X509Certificates.X509Certificate2]::new($cer)
    try {if($public.HasPrivateKey){throw 'stage4_replacement_public_export_contains_key'}}finally{$public.Dispose()}
    $report=[ordered]@{schemaVersion=1;kind='LOCAL_TEST_CERTIFICATE_PREPARATION_NOT_TRUST_APPROVAL';
        publisherSha256=$pin;thumbprint=$created.Thumbprint;subject=$created.Subject;
        notBeforeUtc=$newStatus.notBeforeUtc;expiresUtc=$newStatus.expiresUtc;
        certificateStore='CurrentUser/My';keyAlgorithm='RSA';keyBits=3072;keyExportPolicy='NonExportable';
        certificateCreated=$true;privateKeyExported=$false;trustChanged=$false;buildRequired=$true;
        signingPerformed=$false;installationPerformed=$false;readyToInstall=$false;
        previousPublisherSha256=$ExpectedPublisherSha256;previousCertificatePreserved=$true;
        publicCertificateFile='stage4-private-public.cer';publicBookabilityEnabled=$false}
    $reportPath=Join-Path $target 'certificate-preparation.json'
    [IO.File]::WriteAllText($reportPath,($report|ConvertTo-Json -Depth 6)+"`n",[Text.UTF8Encoding]::new($false))
    $reportHash=(Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $target 'SHA256SUMS'),"$pin  stage4-private-public.cer`n$reportHash  certificate-preparation.json`n",[Text.UTF8Encoding]::new($false))
    Remove-Item -LiteralPath $marker
    $report | ConvertTo-Json -Depth 6
} catch {
    # Keep this new key and its public identity identifiable after a partial error.
    # Never delete an existing certificate, and never import new trust automatically.
    if($null -ne $created){
        [IO.File]::AppendAllText($marker,"`nnewCertificateThumbprint="+$created.Thumbprint)
    }
    throw
}
