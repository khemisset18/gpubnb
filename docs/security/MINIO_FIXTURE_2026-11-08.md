# S3 fixture update — 8 November 2026

Previous run 42400067881 stopped before starting MinIO: CVE-2026-116591 HIGH in mc 0.20250813.083541-r27 (fixed r28) and minio 0.20261023.200651-r2 (fixed r3). Artifact ZIP 13584748677 independently hash-verified as 72721a66026ce483726fd3052b4430bee5cf270fe3bfdfbde75631b554defe98.

Resolve the official public cgr.dev/chainguard/minio latest index to an immutable digest, then use immutable pins only. Registry Docker-Content-Digest matches SHA256 of the downloaded raw index: sha256:869ca3178831d9f521ea02258a0f0d4fbc1e9f84302e707514e1f861b860865d. The index maps linux/amd64 to sha256:e8bfe3456721ee96befba0ae28d0a65a620b810b60cca731f0863e8c70f2d703. No latest tag is retained in the workflow.

This is a candidate fix until CI verifies the image signature, signed SPDX and zero-vulnerability gate, then executes the actual isolated MinIO roundtrip/migration tests. No signature identity, verification tool, severity threshold, ignore-unfixed flag, network isolation, capability restriction, database or application code changed. The two digest replacements are the sole workflow changes. Runtime will not start if the existing security checks fail. No deployment or production data operation.
