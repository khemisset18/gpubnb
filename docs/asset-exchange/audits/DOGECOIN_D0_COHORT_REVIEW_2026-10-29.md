# DOGE D0 cohort review — 2026-10-29

Status: **BLOCKED**. No merge, Mainnet, funds, release-binary execution,
settlement activation, secret or trust-input change.

## Current repository state inspected

| Branch suffix under `asset-exchange/` | Head |
| --- | --- |
| secure-foundation-v1 | 95e4b5adfb19538ba1d817101984cab2dc9e9427 |
| recovery-hardening-2026-10-08 | 803f08f696a33fe1a4661a6219a951a9c12ae01e |
| dogecoin-d0-build-2026-10-08 | e55ece11f991ef8c2ab2019a5cdbf11a85d1ff62 |
| dogecoin-d0-repro-build-2026-10-08 | ad8f619646ce20bf3de3e08bb3aebee0642bad48 |
| dogecoin-d0-evidence-hardening-2026-10-10 | d079273aed6535829af0d95694672f416ab1b1ec |
| doge-d0-kernel-failfast-20261029 | 11e2e6c0d2817b99101c4b1ddff1d37d9a6bffe0 |

PR #283 and #284 were already merged before this work. PR #286, #287 and
#311 are open drafts. This change is based on #311 without merging any branch.
Branch-head inventory is not a claim that every historical file was audited.

## Recovered primary evidence

Run https://github.com/khemisset18/gpubnb/actions/runs/40757273650:
both replica jobs failed; comparison skipped. Direct full Actions console-log
fetch failed repeatedly with `Transport closed`. Instead both diagnostic ZIPs
were downloaded and hashed against GitHub's artifact metadata:

| Replica / artifact | ZIP SHA-256 |
| --- | --- |
| A / 12854481727 | 4ed4b23ec3b252f14b5a3ceb4381a5bc573b0fbc1c951afce1b80b1b6f90fe81 |
| B / 12851817064 | 4e9c0d6ff8ae34b1b770667b57c8ea7155d2a4682f94ff762df6235607d81f2b |

Each contains complete Gitian build/install logs, package manifests and result
YAML. Both result YAMLs declare x86_64 hash
`b0aab5a024db9e1c0df09df716581d41b543fd2fee92be9cef4a981a4130e1b7`.
Neither ZIP includes the release archive: **binary byte equality was not tested**.

Both checked-in 323-line Focal manifests were compared byte-for-byte with the
upstream assertions at `dogecoin/gitian.sigs@9d1be4fb0effc4c2e97750e0763b92f39d474a17`.
Both match. Both upstream assertions contain the unchanged required x86_64 hash
`4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8`.
Dogecoin's v1.14.9 annotated tag currently resolves to the unchanged source
`e0a1c157791544e818c901bd9341896965afbf9d`.
This is content/reference verification, not fresh independent GPG authentication
of release signatures or renewed trust in expired/revoked/unavailable keys.

## Exact package mismatch and correction to prior diagnosis

The replicas mix cohorts. Against KunNw0n, five kernel package entries differ:
5.4.0-200 instead of 5.4.0-202 (meta 5.4.0.200.196 vs 5.4.0.202.198).
Against slightlyskepticalpotat, the kernel matches but two packages differ:
intel-microcode 3.20241112 vs 3.20240910 and libexpat1 ubuntu0.8 vs ubuntu0.7.
The two official manifests do **not** both require kernel 202.
The final full-manifest gate correctly rejects this mixed environment.
This explains that gate failure; it does not establish the sole cause of the
non-official release-archive hash.

PR #311 already added kernel guards. The remaining defects fixed here are:

- validation CI did not trigger for stacked D0 PRs targeting #287/#311 branches;
- installed-package smoke and candidate discovery omitted the kernel cohort;
- duplicated requirements could drift between build, smoke and discovery;
- snapshot discovery did not retain signed indexes for subsequent inspection;
- previous triage did not distinguish the two official environment variants.

The shared guard explicitly targets KunNw0n, consistent with the pre-existing
newer microcode/expat pins. Snapshot discovery retains the existing eight dates,
APT package records, signed metadata/indexes and keyring. It does not promote a
snapshot or grant D0 acceptance. Actual package hash checks, full manifest
equality and official archive hash equality remain mandatory.

## Validation actually executed

- 19 Python tests pass: 13 existing adversarial evidence tests plus 6 cohort tests.
- 150 JavaScript Asset Exchange tests pass, zero failures/skips, TAP reporter.
  Initial run had four failures because `/tmp` was unavailable; rerun used a
  workspace TMPDIR without modifying tests or relaxing assertions.
- D0 shell syntax, workflow YAML parsing and embedded Bash syntax pass.
- `git diff --check` passes.
- Baseline #311 G5 run 40791151996: success. Baseline global CI 40791151979:
  failure at npm HIGH/CRITICAL audit and Trivy HIGH/CRITICAL gate. Not waived.
- New PR CI must be reported separately; local tests do not qualify rootfs
  preparation, snapshots, independent binaries, SBOM or attestations.

No PostgreSQL concurrency integration, TLA+ rerun, new full Gitian builds,
node-network tests, hardware signing or D1-D9 execution occurred in this review.

## Architecture and qualification boundary

Existing isolated zero-runtime-dependency domain/API modules cover atomic
amounts, signed immutable terms, offers, state transitions, cancellation,
sessions, watcher evidence envelopes and recovery. PostgreSQL migrations and
separate concurrency harness exist. Bitcoin-specific settlement modules cover
P2WSH HTLC terms, signing, confirmations and timeout policy. This is not a
complete production cross-chain exchange or a proof that all adapters exist.

| Area | Current evidence boundary |
| --- | --- |
| DOGE | D0 BLOCKED; D1-D9 not started here; specification only; automatic settlement disabled |
| BTC | Existing regtest-only LIMITED route and test harness; production/hardware qualification not completed here |
| LTC | Dedicated specification, marketplace only; executable qualification not performed here |
| XMR | Separate privacy research track, marketplace only; no Bitcoin HTLC reuse or new adapter |
| BCH | Marketplace only; subsequent qualification not started here |

For Monero, existing architecture requires separate view/spend-key boundaries,
private payment detection, confirmation/reorg handling and recovery protocol
review. No current implementation claim is made from that specification.

## Next gated work

1. Inspect newly collected authenticated snapshot evidence against the entire
   chosen manifest; candidate versions alone are insufficient.
2. If a coherent replacement snapshot is proven, request explicit authorization
   before changing the pinned trust input. Do not alter official manifests.
3. Rebuild on independent runners; compare actual archive bytes and the required
   official hash; validate SBOM, provenance and required attestations.
4. Only after D0 passes, follow the existing D1-D9 gates in
   `DOGECOIN_ADAPTER_SPEC_V1.md`, using isolated fictitious/test assets.
5. Keep DOGE and other unqualified chains disabled and advance only independent
   work that cannot imply financial activation.
