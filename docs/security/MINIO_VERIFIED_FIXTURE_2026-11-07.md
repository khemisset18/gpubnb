# S3 integration: dynamic discovery with digest-pinned, verified execution (2026-11-07)

## Motivation and scope

The existing S3-integration job used fixed Chainguard MinIO index and linux/amd64 digests. Run 42400067881 was blocked *before* starting the test fixture by the mandatory Trivy image scan. The reported CVE-2026-116591 in `github.com/klauspost/compress` affected its older pinned fixture; the Trivy gate was correct to refuse executing it. No scan or signature requirement is suppressed.

This branch is stacked on npm dependency remediation PR #338. The workflow change is isolated to `.github/workflows/artifact-storage-s3-integration.yml`; it does not change S3 application code, user data, production images or AWS credentials.

## Candidate-selection procedure

1. Resolve the upstream-maintained `cgr.dev/chainguard/minio:latest` **once** at job start, returning a digest for the exact multiarchitecture OCI index.
2. Re-fetch the index **by immutable digest**. Choose exactly one `linux/amd64` image child from this index; fail closed if none, ambiguous or invalid.
3. Save the index JSON, sha256 and both immutable image references as evidence.
4. Run the existing keyless **Sigstore/cosign provenance check** against the immutable index, and verify the corresponding signed SPDX attestation on the immutable amd64 child.
5. Perform the existing **Trivy full-severity image vulnerability scan** against that child; continue **only if** it reports no findings at the configured all-severity threshold.
6. Run MinIO only as the previously sandboxed, CPU/memory-limited, cap-drop, read-only, disposable linux/amd64 fixture **by the pinned index digest**, then run the existing S3 round-trip and migration tests. Cleanup and artifact retention remain unconditional.

This avoids the older stale digest while preserving immutability **within each CI run**; the tag is never used to run a container, verify an image or scan an image.

## Risk limits and acceptance

- The exact candidate digest can vary between separate CI runs as Chainguard rebuilds its image. A pinned digest and signed SBOM are recorded for each run. If stricter cross-run reproducibility is required, promote the tested digest in a separate reviewed change.
- A clean Trivy result does not prove the absence of every vulnerability. CVE database updates can change the assessment between runs.
- A signed image identifies the configured producer, not necessarily a security audit of MinIO business logic.
- The S3 integration is **PASS only after** the whole updated CI job, including real put/get and migration round trips, passes. Merely updating this workflow is **NOT_TESTED** until the GitHub run finishes.
- If the image signature, SBOM, availability, digest structure, or scanner fails, the job remains **FAIL/BLOCKED**; no waivers, ignore lists, disabling checks or fallback to an unsafe image.
- Rust `borsh`, `glib`, `rand` findings are unrelated and remain separately tracked. See RustSec RUSTSEC-2023-0033 for the discrepancy between some scanners and patched borsh 0.10.4, but do not bypass Trivy without an independent decision.

Sources:
- https://www.chainguard.dev/docs/chainguard/containers/getting-started/web-and-data-services/minio
- https://support.chainguard.dev/hc/en-us/articles/49563564450075-How-Chainguard-Image-Tags-Versions-and-EOL-Work
- https://github.com/advisories/GHSA-fpmh-frq8-7rj8
