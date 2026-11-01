#Requires -Version 5.1
# Offline synthetic fail-closed tests. NO certificate import, real signing or installation.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$scripts=Split-Path -Parent $PSScriptRoot
. (Join-Path $scripts 'stage4-package-common.ps1')
. (Join-Path $scripts 'stage4-private-qualification-policy.ps1')
$names=@(
    'stage4-private-qualification-policy.ps1',
    'new-stage4-private-qualification-package.ps1',
    'verify-stage4-private-qualification.ps1',
    'stage4-private-install-readiness.ps1'
)
foreach ($name in $names) {
    $tokens=$null;$errors=$null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $scripts $name),[ref]$tokens,[ref]$errors)
    if ($errors.Count -ne 0) { throw "private_qualification_parser_error:$($name):$($errors[0].Message)" }
}
$builder=Get-Content -LiteralPath (Join-Path $scripts 'new-stage4-private-qualification-package.ps1') -Raw
$verifier=Get-Content -LiteralPath (Join-Path $scripts 'verify-stage4-private-qualification.ps1') -Raw
if ($builder -match '\b(?:Stop-Service|Restart-Service|Start-Service|Stop-Process|Remove-Service|Import-Certificate|Export-PfxCertificate|Set-Service|Restart-Computer|Set-MpPreference)\b' -or
    $verifier -match '\b(?:Stop-Service|Restart-Service|Start-Service|Stop-Process|Import-Certificate|Export-PfxCertificate|Set-Service|Restart-Computer|Set-MpPreference)\b') {
    throw 'private_qualification_unapproved_host_mutation'
}
if ($builder -notmatch 'Read-Stage4Package' -or
    $builder -notmatch 'verify-stage4-package.ps1' -or
    $verifier -notmatch 'Assert-Stage4PrivateQualificationPolicy') {
    throw 'private_qualification_verification_chain_missing'
}
$commit='1234567890abcdef1234567890abcdef12345678'
$pin='3060de709bd0db7fa8588b7480a8a04f94b2a7df005ee48361cbdcd39b0e9619'
$machine='cmsiggruy0004df0tn669f6bn'
$gpu='GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a'
$renter='gpubnb-renter-qual'
# Exercise the SAME SHA40 guard used by verify-stage4-private-qualification.ps1.
# This does not forge a signed package or bypass real Authenticode checks.
if ($verifier -notmatch 'Assert-Stage4PrivateBuildIdentity' -or
    $verifier -match 'ExpectedCommit\\.Substring\\(0,12\\)') {
    throw 'private_qualification_real_verifier_not_using_sha40_guard'
}
$identityBase=[pscustomobject]@{
    agent=[pscustomobject]@{frozen=$true;agentVersion='0.6.6';buildCommit=$commit}
    helper=[pscustomobject]@{sourceCommit=$commit;workerSignerSha256=$pin;mutationAuthority='release-candidate'}
    worker=[pscustomobject]@{sourceCommit=$commit;mediaSignerSha256=$pin}
    media=[pscustomobject]@{sourceCommit=$commit;mediaAbi=2;nvencApi='13.0'}
    agentRuntime=[pscustomobject]@{tlsContext=$true}
}
if (-not (Assert-Stage4PrivateBuildIdentity -Identity $identityBase -ExpectedCommit $commit -ExpectedPublisherSha256 $pin)) {
    throw 'private_qualification_sha40_exact_rejected'
}
function Expect-IdentityRejection([string]$Title,[scriptblock]$Mutate) {
    $copy=$identityBase | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    & $Mutate $copy
    $denied=$false
    try { [void](Assert-Stage4PrivateBuildIdentity -Identity $copy -ExpectedCommit $commit -ExpectedPublisherSha256 $pin) }
    catch { $denied=($_.Exception.Message -like 'private_qualification_embedded_identity_mismatch*') }
    if (-not $denied) { throw ('private_qualification_identity_not_rejected:'+$Title) }
    Write-Host ('PASS exact shared verifier identity gate '+$Title)
}
Expect-IdentityRejection 'SHA12 agent refused' {param($m)$m.agent.buildCommit=$commit.Substring(0,12)}
Expect-IdentityRejection 'wrong SHA40 agent refused' {param($m)$m.agent.buildCommit=('f'*40)}
Expect-IdentityRejection 'wrong SHA40 Helper refused' {param($m)$m.helper.sourceCommit=('f'*40)}
Expect-IdentityRejection 'wrong SHA40 Worker refused' {param($m)$m.worker.sourceCommit=('f'*40)}
Expect-IdentityRejection 'wrong SHA40 Media refused' {param($m)$m.media.sourceCommit=('f'*40)}
Expect-IdentityRejection 'mismatched Worker signer refused' {param($m)$m.worker.mediaSignerSha256=('e'*64)}
Expect-IdentityRejection 'mismatched Helper signer refused' {param($m)$m.helper.workerSignerSha256=('e'*64)}
Expect-IdentityRejection 'wrong Agent release refused' {param($m)$m.agent.agentVersion='0.6.5'}
Write-Host 'PASS real signed verifier calls the same exact SHA40 identity gate'

$script:base=[ordered]@{
    schemaVersion=1
    kind='GPUBNB_STAGE4_PRIVATE_QUALIFICATION_INSTALLER_CANDIDATE'
    sourceKind='STAGE4_UNSIGNED_PRIVATE_CANDIDATE'
    sourceCommit=$commit
    publisherSha256=$pin
    machineId=$machine
    gpuUuid=$gpu
    renterAccount=$renter
    privateQualificationOnly=$true
    publicBookabilityEnabled=$false
    iddDriverIncluded=$false
    installationPerformed=$false
    installable=$true
    installationReviewRequired=$true
    signatureStatus='private-signed'
    timestamped=$false
    mutationAuthority='release-candidate'
    approvedUse='owner-present-local-private-qualification-only'
    sourceUnsignedManifestSha256=('a'*64)
    buildIdentitiesSha256=('b'*64)
    protocols=@{worker=1;mediaTransport=2;browserMedia=1;browserInput=1;mediaAbi=2}
    expiresUtc=([DateTime]::UtcNow.AddDays(7).ToString('o'))
    files=@(
        @{name='gpubnb-agent.exe';sha256=('1'*64);unsignedSha256=('2'*64);architecture='AMD64'},
        @{name='gpubnb-windows-stream.exe';sha256=('3'*64);unsignedSha256=('4'*64);architecture='AMD64'},
        @{name='gpubnb-windows-worker.exe';sha256=('5'*64);unsignedSha256=('6'*64);architecture='AMD64'},
        @{name='GPUbnbWindowsMedia.dll';sha256=('7'*64);unsignedSha256=('8'*64);architecture='AMD64'}
    )
}
$expected=@{ExpectedCommit=$commit;ExpectedPublisherSha256=$pin;ExpectedMachineId=$machine
    ExpectedGpuUuid=$gpu;ExpectedRenterAccount=$renter}
function Policy($m) {
    Assert-Stage4PrivateQualificationPolicy -Manifest $m @expected
}
function Expect-PolicyRejection([string]$Title,[scriptblock]$Change) {
    $m=($script:base | ConvertTo-Json -Depth 12 | ConvertFrom-Json)
    & $Change $m
    $failed=$false
    try { [void](Policy $m) } catch { $failed=$true }
    if (-not $failed) { throw "private_qualification_missing_rejection:$Title" }
    Write-Host "PASS $Title"
}
$valid=($script:base | ConvertTo-Json -Depth 12 | ConvertFrom-Json)
if (-not (Policy $valid)) { throw 'private_qualification_positive_policy_failed' }
Write-Host 'PASS exact signed local private qualification policy'
Expect-PolicyRejection 'old private noninstallable policy rejected' {param($m)$m.kind='LOCAL_TEST_ONLY_NOT_RELEASE';$m.installable=$false}
Expect-PolicyRejection 'cannot change private installable flag' {param($m)$m.installable=$false}
Expect-PolicyRejection 'public bookings blocked' {param($m)$m.publicBookabilityEnabled=$true}
Expect-PolicyRejection 'private scope required' {param($m)$m.privateQualificationOnly=$false}
Expect-PolicyRejection 'machine change rejected' {param($m)$m.machineId='cmvvpd1s600aser1b06u33u86'}
Expect-PolicyRejection 'GPU change rejected' {param($m)$m.gpuUuid='GPU-00000000-0000-0000-0000-000000000000'}
Expect-PolicyRejection 'renter change rejected' {param($m)$m.renterAccount='hicha'}
Expect-PolicyRejection 'commit change rejected' {param($m)$m.sourceCommit=('f'*40)}
Expect-PolicyRejection 'publisher change rejected' {param($m)$m.publisherSha256=('e'*64)}
Expect-PolicyRejection 'driver inclusion rejected' {param($m)$m.iddDriverIncluded=$true}
Expect-PolicyRejection 'existing install mutation rejected' {param($m)$m.installationPerformed=$true}
Expect-PolicyRejection 'no review bypass' {param($m)$m.installationReviewRequired=$false}
Expect-PolicyRejection 'wrong source kind' {param($m)$m.sourceKind='LOCAL_TEST_ONLY_NOT_RELEASE'}
Expect-PolicyRejection 'wrong protocol' {param($m)$m.protocols.browserInput=2}
Expect-PolicyRejection 'expired signature' {param($m)$m.expiresUtc=[DateTime]::UtcNow.AddHours(-1).ToString('o')}
Expect-PolicyRejection 'duplicated binary' {param($m)$m.files[1].name='gpubnb-agent.exe'}
Expect-PolicyRejection 'missing binary' {param($m)$m.files=@($m.files[0],$m.files[1],$m.files[2])}
Expect-PolicyRejection 'changed source hash' {param($m)$m.files[0].unsignedSha256='not-a-hash'}
# The maintenance preflight is explicitly observational. Invalid external pins
# must fail BEFORE any file access, certificate interaction or service query.
$readiness=Get-Content -LiteralPath (Join-Path $scripts 'stage4-private-install-readiness.ps1') -Raw
if ($readiness -match '\b(?:Stop-Service|Restart-Service|Start-Service|Stop-Process|Remove-Service|Import-Certificate|Export-PfxCertificate|Set-Service|Restart-Computer|Set-MpPreference|Copy-Item|Set-Acl)\b' -or
    $readiness -notmatch 'installAuthorized=\$false' -or
    $readiness -notmatch 'quarantineModified=\$false') {
    throw 'private_qualification_readiness_mutation_or_authority'
}
$refused=$false
try {
    & (Join-Path $scripts 'stage4-private-install-readiness.ps1') -CandidateDirectory 'does-not-exist' -BackupDirectory 'does-not-exist' -ExpectedCandidateManifestSha256 'invalid' -ExpectedBackupManifestSha256 ('a'*64) -ExpectedCommit $commit -ExpectedPublisherSha256 $pin -ExpectedMachineId $machine -ExpectedGpuUuid $gpu -RenterAccount $renter | Out-Null
} catch {
    $refused=$_.Exception.Message -like 'stage4_install_readiness_external_pins_invalid*'
}
if (-not $refused) { throw 'stage4_install_readiness_bad_external_pin_not_rejected' }
Write-Host 'PASS read-only installation readiness policy and invalid external pin rejection'


# Full verifier ENTRYPOINT regression (not just the synthetic policy helper).
# Synthetic manifests and dummy PE files intentionally cannot yield a SUCCESS
# signed-package verification; negative cases must be rejected BEFORE PE checks.
$fixtureRoot=Join-Path $env:TEMP ('stage4-private-verifier-test-'+[Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $fixtureRoot -Force)
try {
    $identityFile=Join-Path $fixtureRoot 'build-identities.json'
    $unsignedFile=Join-Path $fixtureRoot 'unsigned-stage4.manifest.json'
    $signedFile=Join-Path $fixtureRoot 'stage4-private-qualification.manifest.json'
    $unsignedManifest=[ordered]@{
        schemaVersion=2;kind='STAGE4_UNSIGNED_PRIVATE_CANDIDATE'
        sourceCommit=$commit;publisherSha256=$pin;installable=$false
        publicBookabilityEnabled=$false;iddDriverIncluded=$false
        buildIdentitiesSha256='';files=@($script:base.files | ForEach-Object {
            @{name=$_.name;sha256=$_.unsignedSha256;architecture='AMD64';imports=@()}
        })
    }
    foreach($record in $script:base.files) {
        [IO.File]::WriteAllText((Join-Path $fixtureRoot $record.name),'dummy PE - MUST NOT PASS')
    }
    function Write-PrivateVerifierFixture([string]$AgentCommit,[string]$HelperCommit,[string]$WorkerCommit,[string]$MediaCommit) {
        $identity=$identityBase | ConvertTo-Json -Depth 12 | ConvertFrom-Json
        $identity.agent.buildCommit=$AgentCommit
        $identity.helper.sourceCommit=$HelperCommit
        $identity.worker.sourceCommit=$WorkerCommit
        $identity.media.sourceCommit=$MediaCommit
        [IO.File]::WriteAllText($identityFile,($identity | ConvertTo-Json -Depth 12))
        $unsignedManifest.buildIdentitiesSha256=(Get-FileHash -LiteralPath $identityFile -Algorithm SHA256).Hash.ToLowerInvariant()
        [IO.File]::WriteAllText($unsignedFile,($unsignedManifest | ConvertTo-Json -Depth 12))
        $signed=$script:base | ConvertTo-Json -Depth 12 | ConvertFrom-Json
        $signed.buildIdentitiesSha256=$unsignedManifest.buildIdentitiesSha256
        $signed.sourceUnsignedManifestSha256=(Get-FileHash -LiteralPath $unsignedFile -Algorithm SHA256).Hash.ToLowerInvariant()
        [IO.File]::WriteAllText($signedFile,($signed | ConvertTo-Json -Depth 12))
        return (Get-FileHash -LiteralPath $signedFile -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    function Expect-RealVerifierIdentityReject([string]$Title,[string]$Agent,[string]$Helper,[string]$Worker,[string]$Media) {
        $hash=Write-PrivateVerifierFixture $Agent $Helper $Worker $Media
        $message=''
        try {
            & (Join-Path $scripts 'verify-stage4-private-qualification.ps1') `
                -PackageDirectory $fixtureRoot -ExpectedManifestSha256 $hash -ExpectedCommit $commit `
                -ExpectedPublisherSha256 $pin -ExpectedMachineId $machine `
                -ExpectedGpuUuid $gpu -RenterAccount $renter | Out-Null
        } catch { $message=$_.Exception.Message }
        if ($message -notlike '*private_qualification_embedded_identity_mismatch*') {
            throw ('private_qualification_real_verifier_identity_bypass:'+$Title+':'+$message)
        }
        Write-Host ('PASS actual private verifier entrypoint rejects '+$Title)
    }
    Expect-RealVerifierIdentityReject 'SHA12 Agent' ($commit.Substring(0,12)) $commit $commit $commit
    Expect-RealVerifierIdentityReject 'wrong SHA40 Agent' ('f'*40) $commit $commit $commit
    Expect-RealVerifierIdentityReject 'mixed Worker' $commit $commit ('f'*40) $commit
    Expect-RealVerifierIdentityReject 'mixed Helper' $commit ('f'*40) $commit $commit
    Expect-RealVerifierIdentityReject 'mixed Media' $commit $commit $commit ('f'*40)
} finally {
    if(Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Force -Recurse }
}
Write-Host 'PASS real verifier fail-closed identity regression (no false positive signed package)'

Write-Host 'PASS all private qualification policy adversarial checks'
