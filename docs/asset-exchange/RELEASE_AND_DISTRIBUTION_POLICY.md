# gpu.k.p2p Asset Exchange — Release and Distribution Security Policy

Status: PRE-RELEASE POLICY / NOT YET ENFORCED AT REPOSITORY LEVEL / NO MAINNET AUTHORIZATION

## 1. Purpose

This policy defines how gpu.k.p2p Asset Exchange artifacts may progress from source commit to a downloadable release.

It applies only to the technical subsystem `asset-exchange` and its dedicated artifacts. It does not authorize a merge to GPUbnb Core, Mainnet settlement, or real-funds operation.

## 2. Current repository state

Observed on 2026-10-06:
- repository visibility: public;
- GitHub rulesets API returned an empty list;
- existing historical GPUbnb Host releases report `immutable: false`;
- branch-protection status for `main` could not be read through the current GitHub App connection because that endpoint returned 403;
- therefore branch/release protections MUST NOT be assumed.

Consequence:
- Asset Exchange release promotion remains BLOCKED;
- no workflow may claim a protected production release until the repository-level controls below are independently verified.

## 3. Mandatory repository-level controls before first Asset Exchange release

The repository owner MUST configure and independently verify:

1. A dedicated GitHub environment named `asset-exchange-release`.
2. Required reviewer approval for that environment.
3. Self-review prevention.
4. Environment deployment restricted to the approved release branch/tag policy.
5. Administrator bypass disabled where GitHub plan/repository settings permit it.
6. GitHub immutable releases enabled for Asset Exchange releases.
7. Protected branch/ruleset controls for the release source branch.
8. Required status checks for the dedicated Asset Exchange gates.
9. No environment secret containing wallet seeds, wallet private keys, recovery keys, or user signing material.

These are repository settings, not source-code assertions. A document or workflow file does not prove they are enabled.

## 4. Release source

A release candidate MUST bind to one exact 40-character Git commit SHA.

The source commit MUST:
- belong to the reviewed Asset Exchange history;
- have no unreviewed Core dependency;
- be 0 commits behind the approved release source at promotion time;
- pass all required security gates for that exact SHA.

A branch name, mutable tag, "latest", or local working tree is not a valid release identity.

## 5. Required exact-SHA gates

At minimum, before a candidate can be promoted:

- Asset Exchange G5 Foundation: SUCCESS;
- Asset Exchange PostgreSQL concurrency/integration gate: SUCCESS where relevant;
- Asset Exchange Formal Verification: SUCCESS for the current formal model;
- Asset Exchange Bitcoin Regtest: SUCCESS for Bitcoin settlement builds;
- Asset Exchange Recovery Artifact producer: SUCCESS;
- Asset Exchange Recovery Artifact independent consumer verification: SUCCESS;
- Asset Exchange Source Audit Artifact producer: SUCCESS;
- Asset Exchange Source Audit Artifact independent consumer verification: SUCCESS;
- required external signer compatibility checks: SUCCESS for the declared signer profile;
- security audit evidence updated for the exact protocol/release revision.

A successful older commit is not evidence for a changed release candidate.

## 6. Build once, verify, then promote

Release artifacts MUST be produced from a controlled build workflow.

For the recovery tool:
- build twice from the same source commit;
- require byte-for-byte equality;
- generate deterministic SHA-256 checksums;
- generate SPDX 2.3 SBOM;
- recompute internal file hashes against the downloaded tarball;
- bind BUILD_INFO and SBOM metadata to the exact source SHA;
- generate GitHub/Sigstore provenance;
- generate GitHub/Sigstore SBOM attestation;
- verify both attestations in a separate read-only consumer job.

Production distribution MUST promote the already-verified bytes. It MUST NOT rebuild different bytes after approval.

## 7. GitHub release publication

When immutable releases are enabled, publication SHOULD follow GitHub's recommended order:

1. create a draft release;
2. attach every approved artifact, checksum, SBOM, and verification material;
3. verify asset hashes;
4. verify source SHA and release tag target;
5. obtain protected-environment approval;
6. publish the draft exactly once.

After publication:
- the tag MUST NOT move;
- assets MUST NOT be replaced;
- a broken release MUST be superseded by a new version;
- "fixing in place" is forbidden.

Asset Exchange release tags MUST use a dedicated namespace such as:
- `asset-exchange-v0.x.y-rc.N` for candidates;
- `asset-exchange-v0.x.y` only after the corresponding gate is authorized.

Existing GPUbnb Host tags/releases are separate and MUST NOT be reused as Asset Exchange release identities.

## 8. Attestation policy

Released executable/archive artifacts MUST have verifiable provenance.

Preferred mechanism:
- GitHub artifact attestations;
- keyless OIDC/Sigstore signing;
- action references pinned to immutable commit SHA.

Long-lived signing PATs or private release keys SHOULD NOT be introduced when keyless attestation is sufficient.

Consumers MUST verify provenance; merely generating an attestation is not considered a completed security control.

## 9. SBOM policy

Each released runnable artifact MUST have an associated SBOM appropriate to the artifact.

For the standalone recovery tool:
- SPDX 2.3 is required;
- file checksums MUST match the internal tarball contents;
- package verification code MUST verify;
- source commit metadata MUST match the release commit.

The Asset Exchange Source Audit Bundle additionally provides a reproducible SPDX 2.3 inventory of the committed Asset Exchange source boundary:
- `asset-exchange/**`;
- `docs/asset-exchange/**`;
- dedicated `.github/workflows/asset-exchange-*.yml`.

Its producer and independent consumer MUST verify:
- exact source commit and Git tree;
- archive SHA-256;
- per-file SHA-1/SHA-256;
- package verification code;
- GitHub/Sigstore provenance;
- SPDX attestation.

This source bundle is an audit artifact, not a runtime dependency SBOM.

Future web/API/worker/container releases require their own runtime/package/container dependency SBOM and provenance. Neither the recovery SBOM nor the source audit SBOM covers the final deployed product by itself.

## 10. Release manifest

Every promoted release MUST record at least:
- release identifier;
- exact source SHA;
- protocol versions;
- migration set;
- Bitcoin Core/toolchain profile where relevant;
- artifact SHA-256 values;
- SBOM digest;
- provenance attestation reference;
- SBOM attestation reference;
- CI run IDs for required gates;
- known limitations;
- security gate status;
- recovery format version;
- signer compatibility profile;
- configuration hash;
- release approver identity/audit reference.

No secret value belongs in the release manifest.

## 11. Recovery cannot depend on release infrastructure

A new release, rollback, disabled API, disabled marketplace, mode transition, or domain outage MUST NOT remove a previously valid recovery/refund path.

A release kill switch may stop:
- new offers;
- new accepts;
- new locks.

It MUST NOT disable:
- redeem where safe;
- refund;
- recovery export/import;
- recovery reconciliation.

## 12. Rollback and compromised release response

Immutable artifacts are never modified in place.

If a candidate/release is found defective:
1. stop new commitments where necessary;
2. preserve recovery and refund;
3. mark the affected release unsupported/quarantined;
4. publish a new fixed version;
5. preserve forensic evidence and attestations;
6. rotate only credentials proven exposed;
7. do not rotate or invalidate user recovery material unnecessarily.

A rollback MUST NOT silently downgrade protocol safety or change signed trade terms.

## 13. Promotion stages

Allowed progression:

`REGTEST -> SIGNET/TESTNET -> AUDITED CANARY -> PROGRESSIVE MAINNET`

Each transition requires its own evidence.

Mainnet canary additionally requires:
- explicit owner authorization;
- independent external security review/red-team completed;
- release protections verified;
- production timeout/fee policy reviewed;
- signer compatibility approved;
- recovery drill passed with released artifact.

No source commit or CI green state alone authorizes Mainnet.

## 14. Current gate status

As of this policy revision:
- reproducible standalone recovery artifact: PASS;
- recovery SBOM/provenance attestation: PASS;
- recovery independent consumer verification: PASS;
- reproducible Asset Exchange source audit bundle: PASS;
- source bundle SPDX/provenance attestation: PASS;
- source bundle independent consumer verification: PASS;
- deep bounded regtest reorg scenarios: PASS;
- Bitcoin default signet read-only qualification: PASS;
- transactional signet settlement qualification: NOT COMPLETE;
- GitHub repository rulesets: NOT PRESENT when last queried;
- immutable Asset Exchange release setting: NOT VERIFIED / historical releases are not immutable;
- protected release environment: NOT VERIFIED;
- protected branch status: NOT VERIFIED through current connector;
- runtime/container/package dependency SBOM/provenance: NOT COMPLETE;
- external audit: NOT COMPLETE;
- transactional signet/testnet qualification: NOT COMPLETE;
- Mainnet: BLOCKED.

Therefore this policy is defined, but controlled release distribution is NOT YET AUTHORIZED.

## 15. Source audit bundle evidence

Latest verified source audit workflow:
- source commit: `762b7f01e3a3f1b414006650ea166ecb3c6d9627`;
- workflow: `Asset Exchange Source Audit Artifact`;
- run id: `37532079754`;
- producer job: SUCCESS;
- independent consumer verification: SUCCESS;
- G5 on same source commit: SUCCESS, run `37532079726`.

The source bundle is built twice from Git objects at the exact source SHA. Byte-for-byte archive/SBOM/checksum equality is required before attestation.

The independent consumer verifies the downloaded bundle against the exact repository/source SHA and Git tree, then verifies both GitHub/Sigstore provenance and the SPDX SBOM attestation.

This evidence improves audit/review reproducibility. It does not authorize a production release or replace future runtime dependency/container SBOMs.
