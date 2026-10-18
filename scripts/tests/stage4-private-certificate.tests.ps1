#Requires -Version 5.1
# In-memory certificates only. No certificate store, private-key export or trust change.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$scripts=Split-Path -Parent $PSScriptRoot
. (Join-Path $scripts 'stage4-package-common.ps1')
$tokens=$null;$errors=$null
[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $scripts 'stage4-private-certificate.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw "stage4_certificate_parser_failed:$($errors[0].Message)"}
$oldPin='200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a'
$missing=Get-Stage4PrivateCertificateStatus -Certificate $null -ExpectedPublisherSha256 $oldPin
if($missing.status -cne 'absent' -or $missing.signingReady -or -not $missing.renewalRecommended){throw 'stage4_missing_certificate_status_failed'}
Write-Host 'PASS absent exact certificate cannot sign'
$rsa=[Security.Cryptography.RSA]::Create(3072)
try {
    $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=GPUbnb LOCAL PHYSICAL TEST ONLY in-memory audit',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $oids=[Security.Cryptography.OidCollection]::new();[void]$oids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$false))
    foreach($hours in @(-1,23,49,168)){
        $cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddHours($hours))
        try {
            $pin=$cert.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
            $status=Get-Stage4PrivateCertificateStatus -Certificate $cert -ExpectedPublisherSha256 $pin
            if($status.signingReady -or -not $status.codeSigningEku -or -not $status.hasPrivateKey){throw 'stage4_untrusted_certificate_must_not_sign'}
            if($status.renewalRecommended -ne ($hours -le 72)){throw "stage4_renewal_window_failed:$hours"}
            $expected=if($hours -lt 24){'stage4_private_test_certificate_invalid_or_expiring'}else{'stage4_private_certificate_chain_not_trusted'}
            if($status.blockers[0] -cne $expected){throw "stage4_certificate_blocker_failed:$hours"}
            if($status.expiresUtc -cne $cert.NotAfter.ToUniversalTime().ToString('o')){throw 'stage4_certificate_report_expiry_failed'}
            Write-Host "PASS actual in-memory certificate with $hours hours remaining"
            $wrong=Get-Stage4PrivateCertificateStatus -Certificate $cert -ExpectedPublisherSha256 $oldPin
            if($wrong.signingReady -or $wrong.blockers[0] -cne 'stage4_private_wrong_signing_certificate'){throw 'stage4_wrong_certificate_status_failed'}
            $public=[Security.Cryptography.X509Certificates.X509Certificate2]::new($cert.RawData)
            try {
                $publicStatus=Get-Stage4PrivateCertificateStatus -Certificate $public -ExpectedPublisherSha256 $pin
                if($publicStatus.signingReady -or $publicStatus.hasPrivateKey -or $publicStatus.blockers[0] -cne 'stage4_private_test_certificate_unavailable'){
                    throw 'stage4_public_only_certificate_cannot_sign'
                }
            }finally{$public.Dispose()}
        }finally{$cert.Dispose()}
    }
    # Only the chain adapter is replaced for the ready/renewal presentation test.
    # No fake chain success is ever used to sign or accepted as machine evidence.
    $assertBody=${function:Assert-Stage4Certificate}
    try {
        function Assert-Stage4Certificate {param($Certificate,$ExpectedPublisherSha256,$MinimumValidityHours,$RequirePrivateKey)}
        foreach($hours in @(49,168)){
            $cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddHours($hours))
            try {
                $pin=$cert.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
                $status=Get-Stage4PrivateCertificateStatus -Certificate $cert -ExpectedPublisherSha256 $pin
                $expected=if($hours -eq 49){'renewal_recommended'}else{'ready'}
                if(-not $status.signingReady -or $status.status -cne $expected -or @($status.blockers).Count -ne 0){throw 'stage4_ready_renewal_presentation_failed'}
            }finally{$cert.Dispose()}
        }
        Write-Host 'PASS ready and renewal recommendation remain distinct states'
    }finally{${function:Assert-Stage4Certificate}=$assertBody}
}finally{$rsa.Dispose()}
Write-Host 'PASS private certificate status; no Windows trust or policy was changed'
