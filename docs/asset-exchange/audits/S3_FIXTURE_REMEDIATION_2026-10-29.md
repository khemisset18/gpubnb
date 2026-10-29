# S3 fixture replacement — real tests and provenance PASS

Authorization scope: the current mission section 13 permits preparing/applying
a reviewed S3 CI correction and requires a maintained available digest-pinned
fixture. No Core storage behavior or D0 trust input is changed.

Original failure: minio/minio:latest is no longer pullable; Docker exited 125
before either real S3 test. Vendor-maintained public alternative reviewed:
https://images.chainguard.dev/directory/image/minio/overview
https://images.chainguard.dev/directory/image/minio/provenance
https://edu.chainguard.dev/chainguard/containers/getting-started/web-and-data-services/minio/

This is explicitly a change from MinIO's unavailable image to Chainguard's build
of MinIO, not an assertion that both distributions have identical bytes. The
anonymous public OCI index and linux/amd64 manifest were fetched and checked
against their content digests. Index:
`sha256:e234321fd3abff7fb968b0674056e883b702aa1ad93a0d4d795cb6c21fa46407`.
Child: `sha256:abdbe7d805b4dc931053275bc65d6c96ea88e66fd121aa3bb87d7354ecd875c5`.
The config identifies Chainguard, created 2026-10-29, uid 65532, MinIO entrypoint.

Before applying the CI replacement, actual Cosign 3.1.4 verification succeeded
using default Sigstore roots, exact issuer token.actions.githubusercontent.com
and exact vendor-published identity
https://github.com/chainguard-images/images/.github/workflows/release.yaml@refs/heads/main.
The linux/amd64 signed SPDX attestation also verified; its subject is the exact
child digest and it enumerates 470 packages. Raw OCI/config and verification
outputs are retained. No wildcard identity, custom key or verification skip.

CI repeats those verifications, scans the pinned child image at all severities
including unfixed findings, then runs the two original real S3 tests. The
fixture has a private internal Docker network, loopback-only published port,
nonroot identity, read-only filesystem, tmpfs test data and bounded resources.
Only test credentials/data are supplied. No production storage or service is
reachable via the internal fixture network. All evidence is retained and the
fixture is removed. A signature, scan, readiness or test failure blocks PASS.

Local signature/SBOM verification is proven; container execution and S3
compatibility are **IMPLEMENTED BUT NOT YET VALIDATED** until CI completes.
An unavailable old digest or future vulnerability must block, not fall back to
latest or another provider. A digest pin proves identity, not perpetual support.

## First real CI attempt and network diagnosis

Run 40913907434 verified the fixture signature and signed SBOM and its full
image Trivy gate passed. It then downloaded and started the pinned MinIO
successfully but the loopback-published readiness probe failed. Server logs
show a normal initialized MinIO listener on the private internal-bridge IP.
The internal Docker bridge deliberately has no external NAT path. The corrected
harness explicitly targets its inspected private IPv4 from the runner's directly
connected bridge route, passes that same endpoint to both real S3 tests and
retains the internal network/loopback-only port restrictions. No public network
or test threshold is opened. This hypothesis still requires a successful real
round trip, not just a startup log; the failed run stays FAILED.

## Completed real validation

**TERMINÉ ET PROUVÉ** for this CI fixture and the two specified tests.
Run https://github.com/khemisset18/gpubnb/actions/runs/40914795552 at commit
3f178f65dc97e0a8e4882c116a14e39c9a4973fc succeeded. Signature, signed SPDX,
all-severity image scan (zero findings), private readiness, actual put/get and
historical filesystem→S3 migration passed, each test with zero failures/skips.
Cleanup and evidence upload succeeded. Artifact 12916145188 ZIP SHA-256:
1539e295c7fe1b7ced3d4b51d2b771842899f7e606ec2ff2a047f1039869b17c.
The downloaded ZIP digest, exact six public members, test counts and actual
image report were checked independently. Original ZIP and summary are retained.
The failed NAT-readiness run remains FAILED. This establishes fixture endpoint
compatibility without relaxing its internal network or security gates.
