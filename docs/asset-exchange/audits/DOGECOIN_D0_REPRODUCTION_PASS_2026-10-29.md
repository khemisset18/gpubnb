# DOGE D0: official Linux x86_64 archive reproduced

Status: **PASS_INTERNAL_REPRODUCIBLE_BUILD**, strictly for the source-rebuild
route defined by the unchanged D0 trust policy. **DO NOT MERGE.** Global CI
security gates still fail; no production, binary execution or settlement is
authorized by this result.

## Completed evidence

[Run 40866305437](https://github.com/khemisset18/gpubnb/actions/runs/40866305437),
tested harness commit `99724d5b66b9475dcb96f6c471c75ce01ed60f9a`: both independent
Gitian builds, comparison, SBOM/provenance generation, both attestations and
evidence upload **SUCCESS**. Times below are Europe/Paris on 2026-10-29.

| Job | Job ID | GitHub-hosted runner ID | Started | Completed |
| --- | --- | --- | --- | --- |
| Replica A | 123422309712 | 1000070443 | 12:34:40 | 14:24:27 |
| Replica B | 123422309459 | 1000070442 | 12:34:41 | 13:59:00 |
| Compare/attest | 123474376751 | 1000070444 | 14:24:30 | 14:24:57 |

The official release download and the actual archives from A, B and the verified
evidence artifact were compared as **complete bytes**, not just declared hashes.
All four are identical: 35,518,706 bytes, SHA-256:

```text
4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8
```

| Downloaded Actions artifact | ID | ZIP SHA-256, verified against GitHub metadata |
| --- | --- | --- |
| Replica A | 12900323164 | `0527c0ea0acd61a861ea6cb8a14900da16b3659cdf1cc733930f499ff0bb74e1` |
| Replica B | 12898412755 | `83115f36b44bf0156511758e7b7df1e475e8cdeb5f0fbdb60b395ab223413d6d` |
| Verified evidence | 12900786335 | `210b98900825e71067da6d6c6dfb160b3f881a6b9db3ab0c14e1e173b26f1b2e` |

Both 323-package generated manifests byte-match KunNw0n; both source metadata
records contain the original annotated tag and `#define BUILD_DESC "v1.14.9"`.
The unchanged evidence verifier was rerun locally on the downloaded A/B inputs.
Its SPDX, provenance and archive-member outputs byte-match those produced by CI.
Archive safety inspection passes; the SPDX accounts for all 11 regular files.

Both Gitian result YAMLs also declare all nine output hashes identically to both
upstream assertions at `dogecoin/gitian.sigs@9d1be4fb0effc4c2e97750e0763b92f39d474a17`.
Actual output-byte comparison and this qualification cover **Linux x86_64 only**;
the other output archives were not independently downloaded here.

## Cause established, correction bounded

The [prior investigation](DOGECOIN_D0_RELEASE_METADATA_2026-10-29.md) records the
failed archives: identical full Focal manifests but non-official archive hash
`b0aab5a024db9e1c0df09df716581d41b543fd2fee92be9cef4a981a4130e1b7`.
Gitian fetched the source SHA with `--no-tags`, so upstream `share/genbuild.sh`
embedded `v1.14.9.0-e0a1c1577`, rather than the official `v1.14.9`.

The sole functional build change preloads only the original annotated release
tag into Gitian's actual input checkout, requires it to peel to the existing
source pin, and checks the upstream-generated version header. Gitian still
receives the same source SHA. The source, builder, descriptor, snapshot, source
hashes, official hashes/manifests, signing keys, trust policy and acceptance
rules are unchanged. The full official archive match now demonstrates that this
correction removes the remaining archive divergence in both independent builds.

31 Python D0 tests, including seven real Git-fetch regressions, pass locally and
in CI. D0 Evidence Security run 40866312396 and G5 run 40866312404 pass. The
unchanged comparator still rejects the old, identical non-official archives.

## Independent cryptographic verification

Both retained Sigstore bundles were independently verified with official GitHub
CLI 2.103.3. Its downloaded Linux amd64 tarball matched the official asset digest
`4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d`.
Roots were obtained through the CLI's default authenticated TUF flow and captured
for offline verification, without editing repository trust inputs or keys.

Verification enforces repository `khemisset18/gpubnb`, the exact D0 workflow,
source and signer digest `99724d5b66b9475dcb96f6c471c75ce01ed60f9a`, the authorized
branch ref, and GitHub-hosted runners. Verified certificates additionally match
repository ID `1305325878`, owner ID `103233875` and run 40866305437 attempt 1.

| Attestation | Enforced predicate | Rekor witnessed time, Paris | Result |
| --- | --- | --- | --- |
| Provenance | `https://slsa.dev/provenance/v1` | 14:24:42 | cryptographic PASS |
| SPDX SBOM | `https://spdx.dev/Document/v2.3` | 14:24:47 | cryptographic PASS |

Both signed subjects bind the exact official archive SHA-256. The signed SBOM
predicate equals the independently regenerated SPDX document in full. An
unversioned SPDX predicate query was rejected; the successful verification uses
the canonical SPDX 2.3 predicate, not an exception to signature checks.

Raw bundles, SPDX, provenance, per-member official comparison and certificate/
verification summary are committed under
[`evidence/doge-d0-20261029/`](evidence/doge-d0-20261029/).
Raw failed and corrected artifact ZIPs, the official archive and complete
verification outputs are retained separately for replay after Actions expiry.

## Remaining boundaries

- Global CI run 40866312557 still fails npm HIGH/CRITICAL audit and Trivy gates;
  these failures are unwaived. API, Agent, contract and production-gate jobs pass.
- Snapshot discovery run 40866312594 has a successful pinned December 15 job and
  seven rejected alternatives; its overall failure is not relabeled a pass.
- Upstream prebuilt GPG signer provenance remains **BLOCKED**. This result uses
  only the already approved independent source-rebuild route.
- No downloaded/rebuilt Dogecoin executable was run. No merge, main/Core or
  financial-production change, Mainnet, real funds, automatic settlement,
  D1-D9 execution or qualification of another chain occurred.
