#Requires -Version 5.1
# Integration test of opt-in creation on a disposable GitHub-hosted runner only.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted'){
    throw 'stage4_certificate_rehearsal_disposable_windows_runner_required'
}
foreach($name in @('GPUBNB_CODESIGN_THUMBPRINT','GPUBNB_CODESIGN_PFX_BASE64','GPUBNB_CODESIGN_PFX_PASSWORD')){
    if(Test-Path "Env:$name"){throw 'stage4_certificate_rehearsal_real_signing_environment_forbidden'}
}
$scriptPath=Join-Path (Split-Path -Parent $PSScriptRoot) 'stage4-private-certificate.ps1'
$directory=Join-Path ([IO.Path]::GetTempPath()) ('stage4-certificate-rehearsal-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($directory)
$old=$null;$replacement=$null
function Get-TrustSnapshot {
    $values=@()
    foreach($store in @('Cert:\CurrentUser\Root','Cert:\CurrentUser\TrustedPublisher','Cert:\LocalMachine\Root','Cert:\LocalMachine\TrustedPublisher')){
        $values+=@((Get-ChildItem -LiteralPath $store)|ForEach-Object {$store+':'+$_.Thumbprint})
    }
    return ($values|Sort-Object)-join "`n"
}
try {
    $before=Get-TrustSnapshot
    $old=New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=GPUbnb LOCAL PHYSICAL TEST ONLY certificate rehearsal OLD' `
        -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddHours(2)
    $oldPin=$old.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
    $count=@(Get-ChildItem Cert:\CurrentUser\My).Count
    $audit=& $scriptPath -ExpectedPublisherSha256 $oldPin|ConvertFrom-Json
    if($audit.certificateCreated -or $audit.trustChanged -or $audit.certificate.signingReady -or -not $audit.certificate.renewalRecommended){throw 'stage4_certificate_read_only_audit_failed'}
    if(@(Get-ChildItem Cert:\CurrentUser\My).Count -ne $count){throw 'stage4_certificate_audit_created_key'}
    $previewOut=Join-Path $directory 'preview'
    & $scriptPath -ExpectedPublisherSha256 $oldPin -CreateReplacement -OutputDirectory $previewOut -WhatIf | Out-Null
    if((Test-Path -LiteralPath $previewOut) -or @(Get-ChildItem Cert:\CurrentUser\My).Count -ne $count){throw 'stage4_certificate_whatif_mutated_machine'}
    Write-Host 'PASS read-only audit and WhatIf create no key or output'
    $out=Join-Path $directory 'replacement'
    $report=& $scriptPath -ExpectedPublisherSha256 $oldPin -CreateReplacement -OutputDirectory $out|ConvertFrom-Json
    $replacement=Get-Item -LiteralPath ('Cert:\CurrentUser\My\'+$report.thumbprint)
    if(-not $report.certificateCreated -or $report.privateKeyExported -or $report.trustChanged -or $report.signingPerformed -or $report.installationPerformed -or $report.readyToInstall -or -not $report.buildRequired){throw 'stage4_certificate_replacement_report_failed'}
    if(-not (Test-Path -LiteralPath ('Cert:\CurrentUser\My\'+$old.Thumbprint))){throw 'stage4_certificate_replacement_removed_old_key'}
    if($replacement.NotAfter -lt (Get-Date).AddDays(13) -or $replacement.NotAfter -gt (Get-Date).AddDays(15)){throw 'stage4_certificate_replacement_duration_failed'}
    if(@(Get-ChildItem -LiteralPath $out -File).Count -ne 3 -or (Test-Path (Join-Path $out 'INCOMPLETE-CERTIFICATE-PREPARATION.txt'))){throw 'stage4_certificate_replacement_files_failed'}
    $audit=& $scriptPath -ExpectedPublisherSha256 $report.publisherSha256|ConvertFrom-Json
    if($audit.certificate.signingReady -or $audit.certificate.blockers[0] -cne 'stage4_private_certificate_chain_not_trusted'){throw 'stage4_certificate_replacement_must_still_require_trust'}
    if((Get-TrustSnapshot) -cne $before){throw 'stage4_certificate_replacement_modified_trust'}
    Write-Host 'PASS actual RSA 3072 CNG nonexportable replacement, public CER hash, old key preserved'
    Write-Host 'PASS new certificate remains untrusted; all four trust stores unchanged'
    $rejected=$false
    try {& $scriptPath -ExpectedPublisherSha256 $oldPin -CreateReplacement -OutputDirectory $out|Out-Null}catch{
        if($_.Exception.Message -cne 'stage4_private_output_must_be_new'){throw};$rejected=$true
    }
    if(-not $rejected){throw 'stage4_certificate_replacement_reused_output'}
    Write-Host 'PASS existing output rejected before creating another key'
}finally{
    foreach($cert in @($replacement,$old)){
        if($null -ne $cert){Remove-Item -LiteralPath ('Cert:\CurrentUser\My\'+$cert.Thumbprint) -DeleteKey -Force -ErrorAction SilentlyContinue}
    }
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
}
