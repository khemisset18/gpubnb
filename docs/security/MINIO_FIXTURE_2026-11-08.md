# S3 fixture update — 8 November 2026

Previous run 42400067881 stopped before starting MinIO: CVE-2026-116591 HIGH in mc 0.20250813.083541-r27 (fixed r28) and minio 0.20261023.200651-r2 (fixed r3). Artifact ZIP 13584748677 independently hash-verified as 72721a66026ce483726fd3052b4430bee5cf270fe3bfdfbde75631b554defe98.

Resolve the official public cgr.dev/chainguard/minio latest index to an immutable digest, then use immutable pins only. Registry Docker-Content-Digest matches SHA256 of the downloaded raw index: sha256:869ca3178831d9f521ea02258a0f0d4fbc1e9f84302e707514e1f861b860865d. The index maps linux/amd64 to sha256:e8bfe3456721ee96befba0ae28d0a65a620b810b60cca731f0863e8c70f2d703. No latest tag is retained in the workflow.

This is a candidate fix until CI verifies the image signature, signed SPDX and zero-vulnerability gate, then executes the actual isolated MinIO roundtrip/migration tests. No signature identity, verification tool, severity threshold, ignore-unfixed flag, network isolation, capability restriction, database or application code changed. The two digest replacements are the sole workflow changes. Runtime will not start if the existing security checks fail. No deployment or production data operation.

## Verified result

PASS: isolated S3 workflow run 42424612097 at c24c2fa7ec5e88090d6530aeee4c36657a4acbd0. Image signature and signed SPDX checks pass. Trivy reports zero findings at every severity; installed mc is 0.20250813.083541-r28 and minio is 0.20261023.200651-r3. Both real MinIO integration tests (roundtrip and migration) pass, 2 total and zero skips. Artifact 13594492586 was independently downloaded; SHA256 2716fb780bec1d394b3cf56d19702ca95188eec17a12bae04f56f77434d33fda matches upload digest. Complete public evidence is retained in evidence/minio-20261108/s3-fixed.zip.

General CI run 42424612037: dependency-audit, desktop-security, contract, agent, API and production-gates PASS. security-static-analysis FAIL remains for borsh 0.10.4 / GHSA-fjx5-qpf4-xjf2, glib 0.18.5 / GHSA-wrw7-89jp-8q8g and rand 0.7.3 / GHSA-cq8v-f236-94qc. These Rust findings are outside the MinIO image and have not been suppressed or corrected by this patch.
