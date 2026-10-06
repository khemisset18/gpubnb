# Asset Exchange Release Evidence Manifest V1

Status: PRE-RELEASE EVIDENCE FORMAT / NO RELEASE AUTHORIZATION / NO MAINNET AUTHORIZATION

SLSA/in-toto provenance remains authoritative for how an artifact was built. This gpu.k.p2p manifest complements provenance with product-specific evidence: exact source SHA, protocol versions, migrations, artifact/SBOM hashes, attestation references, dedicated security workflow runs, recovery format, Bitcoin Core profile, and known limitations.

Every gate in a manifest MUST have conclusion `success`, MUST point to the exact `sourceCommit`, and MUST come from a dedicated `.github/workflows/asset-exchange-*.yml` workflow. Older green runs cannot be reused for changed source.

Required gate policy remains external and explicit: callers pass required gate IDs to `assertRequiredReleaseGatesV1`. The manifest helper cannot silently redefine release policy.

Lists are normalized before hashing. `releaseEvidenceDigestHex` is SHA-256 over Asset Exchange canonical serialization. This digest is metadata correlation evidence only; it does not replace GitHub/Sigstore provenance or SBOM attestations.

Manifest V1 is deliberately pre-Mainnet and requires:
- `mainnetAuthorized=false`;
- `realFundsAuthorized=false`.

This format does not create tags/releases, configure environments, authorize signet transactions, or authorize Mainnet.
