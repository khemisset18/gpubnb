# Trivy scanner refresh — 9 November 2026

Observed CI run 42543552791 used Trivy v0.70.0 through trivy-action v0.36.0's default. The official immutable v0.76.2 release, published 5 November 2026, includes security updates for the scanner's own dependencies. Pin the CLI version explicitly in filesystem and S3 image scanning; pin the already-used action version to its exact commit in the filesystem job as the S3 job already does.

Official release: https://github.com/aquasecurity/trivy/releases/tag/v0.76.2
Action commit: ed142fd0673e97e23eac54620cfb913e5ce36c25 (v0.36.0)

No severity, scanner category, dev-dependency inclusion, ignore-unfixed setting, filtering, skip directory, security gate, image signature identity, SPDX verification, or MinIO image digest changes. No advisory exemption. The scanner update is not represented as a dependency remediation or proof that the Borsh feed mismatch disappears. Fresh filesystem and real S3 integration CI results are required.

The separately verified Borsh 0.10.4 guard and nine passing contract/regression tests are in PR #347. glib/rand findings remain unresolved. No production deployment or merge.

## Verified scanner execution

Both jobs explicitly report v0.76.2. Filesystem CI run 42544195610 / security job 128925531452 retains three findings (borsh 0.10.4, glib 0.18.5, rand 0.7.3), so the security gate remains FAIL. Artifact 13642159541 ZIP SHA256 72ffa5da37da24e998887b849f6ebd02ebd3e8e50fd659f6c1697022c88f966f independently verified. This update does not eliminate the Borsh feed inconsistency; no finding is hidden.

S3 run 42544195665 / job 128925530861 PASS: image signature and signed SPDX verification, zero image vulnerabilities at every severity, private fixture startup, both real roundtrip/migration tests (2 total, zero failures). Artifact 13642806199 ZIP SHA256 e2ad9bc1947e832c7cdc7751da1d6decedcb630f7d9ed113a44d3dd425b29e66 independently verified; parsed image report has zero findings. Bounded extracted summaries are committed under evidence/trivy-20261109; original ZIPs retained locally and in Actions.

The original scanner findings and the upgraded findings agree on those three package identifiers. Borsh's corrected runtime behavior remains independently proven by #347; glib/rand remain unresolved. Scanner maintenance and application dependency remediation are distinct outcomes.
