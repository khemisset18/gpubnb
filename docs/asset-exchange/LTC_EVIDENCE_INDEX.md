# Litecoin evidence index (L0–L9)

## Exact baseline
- Project/PR: https://github.com/khemisset18/gpubnb/pull/359
- Baseline Exchange commit: `b7d7b44c07ee59e9f43ce4632e2a120f699e2253`.
- Original Litecoin L0 HEAD: `e7e8c0df97979203d0a53833484cad552a0c37e9`.
- Review the PR current head and commit-specific checks before attributing any new result.
- Original Litecoin L0 CI: https://github.com/khemisset18/gpubnb/actions/runs/43119399878 (11/11, offline only).
- Original G5 Foundation CI: https://github.com/khemisset18/gpubnb/actions/runs/43119399548 (passed).
- General CI: https://github.com/khemisset18/gpubnb/actions/runs/43119395855 and https://github.com/khemisset18/gpubnb/actions/runs/43119399483 (vulnerability gates failed).

## Candidate upstream provenance (NOT verified evidence)
- Litecoin Core `v0.21.5.8`; upstream tag object `ee2aea3fc3fd95213d1a041d561b52e07ae6dc63`.
- Source commit `ec1b6489a900d09cf5991e220dce089c77a232a2`.
- Candidate archive `litecoin-0.21.5.8-x86_64-linux-gnu.tar.gz`, size `36951482` bytes.
- Published candidate SHA-256 `43200c9f9d65ebc126ea5833ca9429e144c4b3273da6bb9f4e89fd7450ab1be9`.
- Sources: https://github.com/litecoin-project/litecoin/releases/tag/v0.21.5.8 and https://download.litecoin.org/litecoin-0.21.5.8/
- Official `SHA256SUMS.asc` and publisher key are NOT independently authenticated in this mission.
- GitHub tag verification `unknown_key` is an unresolved trust-chain issue, not proven falsification.
- A candidate archive has since been downloaded and SHA-256 checked in a
  public, read-only GitHub Actions provenance job. It was NEVER executed.
  No native transactions or reproduced build have occurred (see follow-up).

## Foundation scan failures, exact original SHA
Source artifacts: 43119395855 / `trivy-filesystem-report` artifact 13898884865 and
`npm-audit-report` artifact 13899673113 (collected 2026-11-12).

Trivy reports seven entries (including duplicated Node advisories in root and API):
- `Cargo.lock`: `borsh 0.10.4`, `GHSA-fjx5-qpf4-xjf2` (MEDIUM, proposed fixed `1.0.0-alpha.1`; alpha upgrade needs compatibility evaluation).
- `Cargo.lock`: `glib 0.18.5`, `GHSA-wrw7-89jp-8q8g` (MEDIUM; fixed `0.20.0`).
- `Cargo.lock`: `rand 0.7.3`, `GHSA-cq8v-f236-94qc` (LOW; fixed `0.8.6`, `0.9.3` or `0.10.1`).
- `package-lock.json` and `apps/api/package-lock.json`: `glob 13.0.6`,
  `CVE-2026-118773 / GHSA-3g3m-2fjr-6pw4` (MEDIUM; Trivy fixed `14.0.2`).
- Same two Node lockfiles: `minimatch 10.2.5`,
  `CVE-2026-118764 / GHSA-g3hv-75wg-m249` (MEDIUM; Trivy fixed `11.0.1`).
- npm audit lists three moderate package entries per tree:
  `@fastify/static` (direct, affected transitively), `glob`, and `minimatch`;
  it reports `fixAvailable=true`. Affected call paths and runtime exposure are NOT established.
These are foundation dependency issues, not introduced by LTC L0; remediate in a
separate authorized dependency change. Do not disable scanning or claim the
suggested version is compatible without tests.

## Evidence collection requirements for the next operator
For each native/manual activity save timestamp, operator, immutable SHA,
binary+source hashes, GPG key trust chain, exact command and tool versions,
signed outputs (redacted of secrets), isolated VM/environment and policy
decision, block heights and chain identity, failure traces and artifact hashes.
Missing evidence means BLOCKED, never PASS.

## Follow-up: pinned source tag cryptographic analysis (2026-11-12)

- Official security fingerprint: David Burkett
  `D35621D53A1CC6A3456758D03620E9D387E55666` from
  https://github.com/litecoin-project/litecoin/blob/v0.21.5.8/SECURITY.md .
- Public key: `contrib/gitian-keys/davidburkett38-key.pgp` in the official
  tag source, 3,159 bytes, SHA-256
  `c514703dde4bd7d36dcd47ee5c7109efa7d8fa03d269e1cf44a6d8e992e923e8`.
- Source GitHub annotated tag API signature and payload retrieved independently
  of the key text. Original payload 150 bytes SHA-256
  `37a1ab7011679340f5c560a984b5e9f92dcad4b439e186c105d2ca62f0ba0898`;
  ASCII armored tag signature 870 bytes SHA-256
  `2586ac650f8182bd7d20d78609409b8ff0bcfd59f81527de8b17c6113ffeb5df`.
- Reconstructed raw tag object 1,020 bytes. Git SHA-1 of
  `b"tag 1020\\0" + raw_tag` matched annotated tag object
  `ee2aea3fc3fd95213d1a041d561b52e07ae6dc63`.
- Local GnuPG executed against the reconstructed **real upstream tag** and
  the upstream archived public key: `VALIDSIG` cryptographically,
  plus `KEYEXPIRED` and `EXPKEYSIG`. GPG exited 0 despite these error
  statuses. The archived key's primary and subkey expiration timestamps are
  2022-04-26T01:50:51Z. A tag from 2026-09-09 is NOT ACCEPTED under this key.
  This result is a real cryptographic tag check, not a test of the real binary,
  not an identity authentication and not a PASS for L0.
- The upstream download directory
  https://download.litecoin.org/litecoin-0.21.5.8/
  lists `davidburkett38-key.pgp` at **5,560 bytes**, unlike the 3,159-byte
  repository copy. The actual 5,560-byte release key was downloaded in
  run 43123327322, matched to the expected full fingerprint and passed
  GPG verification of the signed manifest and source tag. This evidence
  does not replace an independent out-of-band identity/trust check.
- Two Gitian Linux assertion files are in
  https://github.com/litecoin-project/gitian.sigs.ltc/tree/master/0.21.5.8-linux
  under `davidburkett38` and `losh11`. Each claims the same x86_64 archive
  hash `43200c9f9d65ebc126ea5833ca9429e144c4b3273da6bb9f4e89fd7450ab1be9`
  and source commit `ec1b6489a900d09cf5991e220dce089c77a232a2`.
  Their assertion **signatures have not been independently verified**, nor
  are they substitutes for a genuinely reproduced local build.
- The official release metadata for `SHA256SUMS.asc` (1,793 bytes)
  advertises SHA-256 `69f88cae8cb1016bcdcefc2a5b8689dd940c42a04e380afa309a34250522d022`.
  Both public files were subsequently downloaded and cryptographically
  checked in a networked CI run. See exact-HEAD run below.
- Action: obtain an independent out-of-band signer identity endorsement;
  inspect key expiration/certifications and build dependencies; arrange
  independent reproducible source build comparison and Gitian signoff;
  only then reassess L0.
- All financial flags remain disabled; `L0=BLOCKED`.

## Verified official public artifacts — exact code SHA d6e9edf (2026-11-12)
- Workflow https://github.com/khemisset18/gpubnb/actions/runs/43123327322
  status **SUCCESS**, source checked out at
  `d6e9edf6824697674573a88b69da917bfaa82e78`, not the synthetic
  pull-request merge SHA.
- Run artifact `ltc-l0-public-provenance-observations`, artifact ID
  `13900479732`, ZIP digest
  `sha256:c0d146f9cb4788ac3c451d16643106596aad8fcfbdb1f5148aff2e74ea17af3f`.
- Observed actual SHA-256, pinned checks and payloads:
  - `SHA256SUMS.asc`: `69f88cae8cb1016bcdcefc2a5b8689dd940c42a04e380afa309a34250522d022`
    (publisher GitHub asset digest pin).
  - refreshed `davidburkett38-key.pgp` from official release directory:
    `72151da0ab796aec3393ec8834d3ae2a12f6d37e07947357a5d59ad2caa1d7da`,
    fingerprint `D35621D53A1CC6A3456758D03620E9D387E55666`.
  - `litecoin-0.21.5.8-x86_64-linux-gnu.tar.gz`:
    `43200c9f9d65ebc126ea5833ca9429e144c4b3273da6bb9f4e89fd7450ab1be9`;
    measured 36,951,482 bytes.
  - `v0.21.5.8.tag` raw annotated Git object:
    `ad26778aaf0fe45bc2d15990871bbc071662ae203cdb41473364b30332b90788`
    (SHA-256) and pinned Git tag object OID `ee2aea3fc3fd95213d1a041d561b52e07ae6dc63`.
- Actual verifier results: `BINARY_VERIFY_EXIT=0`, `TAG_VERIFY_EXIT=0`.
  `binary-provenance.json`: `binaryChecksumAndSignatureVerified=true`.
  `source-tag.json`: `tagSignatureCryptographicallyVerifiedWithProvidedKey=true`.
  **Both outputs explicitly say `l0Qualified=false`, `settlementEnabled=false`.**
  No native Litecoin executable was extracted, installed, run or connected.
- Limits: key was obtained from a publisher-controlled download host, not
  independently certified out of band; no isolated reproducible build, audited
  dependency graph or verified multiple-builder release attestations.
  Accordingly `L0=BLOCKED`. All historical checks are attributed to
  their exact code SHA. Never treat passing GPG as proof of financial safety.
