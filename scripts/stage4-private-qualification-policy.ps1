#Requires -Version 5.1
# Strict data-only policy for a NEW, separately signed, PRIVATE physical-qualification package.
# This file neither signs nor installs anything. It is NOT a production release policy.
Set-StrictMode -Version Latest

function Assert-Stage4PrivateQualificationPolicy {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$Manifest,
        [Parameter(Mandatory=$true)][string]$ExpectedCommit,
        [Parameter(Mandatory=$true)][string]$ExpectedPublisherSha256,
        [Parameter(Mandatory=$true)][string]$ExpectedMachineId,
        [Parameter(Mandatory=$true)][string]$ExpectedGpuUuid,
        [Parameter(Mandatory=$true)][string]$ExpectedRenterAccount
    )
    if ($ExpectedCommit -cnotmatch '^[0-9a-f]{40}$' -or
        $ExpectedPublisherSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $ExpectedPublisherSha256 -match '^(.)\1{63}$' -or
        $ExpectedMachineId -cnotmatch '^c[a-z0-9]{15,40}$' -or
        $ExpectedGpuUuid -cnotmatch '^GPU-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or
        $ExpectedRenterAccount -cnotmatch '^[A-Za-z0-9._-]{1,64}$') {
        throw 'private_qualification_invalid_expected_scope'
    }
    if ($null -eq $Manifest -or
        $Manifest.schemaVersion -ne 1 -or
        $Manifest.kind -cne 'GPUBNB_STAGE4_PRIVATE_QUALIFICATION_INSTALLER_CANDIDATE' -or
        $Manifest.sourceCommit -cne $ExpectedCommit -or
        $Manifest.publisherSha256 -cne $ExpectedPublisherSha256 -or
        $Manifest.machineId -cne $ExpectedMachineId -or
        $Manifest.gpuUuid -cne $ExpectedGpuUuid -or
        $Manifest.renterAccount -cne $ExpectedRenterAccount -or
        $Manifest.privateQualificationOnly -cne $true -or
        $Manifest.publicBookabilityEnabled -cne $false -or
        $Manifest.iddDriverIncluded -cne $false -or
        $Manifest.installationPerformed -cne $false -or
        $Manifest.installable -cne $true -or
        $Manifest.installationReviewRequired -cne $true -or
        $Manifest.signatureStatus -cne 'private-signed' -or
        $Manifest.timestamped -cne $false -or
        $Manifest.sourceKind -cne 'STAGE4_UNSIGNED_PRIVATE_CANDIDATE' -or
        $Manifest.mutationAuthority -cne 'release-candidate' -or
        $Manifest.approvedUse -cne 'owner-present-local-private-qualification-only') {
        throw 'private_qualification_policy_mismatch'
    }
    if ($Manifest.sourceUnsignedManifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $Manifest.buildIdentitiesSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $Manifest.protocols.worker -ne 1 -or
        $Manifest.protocols.mediaTransport -ne 2 -or
        $Manifest.protocols.browserMedia -ne 1 -or
        $Manifest.protocols.browserInput -ne 1 -or
        $Manifest.protocols.mediaAbi -ne 2) {
        throw 'private_qualification_provenance_invalid'
    }
    $expires=Convert-Stage4ExpiryToUtc $Manifest.expiresUtc
    if ($expires -le [DateTime]::UtcNow.AddHours(24)) {
        throw 'private_qualification_certificate_expired_or_expiring'
    }
    $names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe','gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
    if (@($Manifest.files).Count -ne 4) { throw 'private_qualification_components_invalid' }
    foreach ($name in $names) {
        $hits=@($Manifest.files | Where-Object { $_.name -ceq $name })
        if ($hits.Count -ne 1 -or
            $hits[0].sha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $hits[0].unsignedSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $hits[0].architecture -cne 'AMD64') {
            throw 'private_qualification_components_invalid'
        }
    }
    return $true
}
