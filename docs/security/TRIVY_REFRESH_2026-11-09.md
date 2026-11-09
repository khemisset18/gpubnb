# Trivy scanner refresh — 9 November 2026

Observed CI run 42543552791 used Trivy v0.70.0 through trivy-action v0.36.0's default. The official immutable v0.76.2 release, published 5 November 2026, includes security updates for the scanner's own dependencies. Pin the CLI version explicitly in filesystem and S3 image scanning; pin the already-used action version to its exact commit in the filesystem job as the S3 job already does.

Official release: https://github.com/aquasecurity/trivy/releases/tag/v0.76.2
Action commit: ed142fd0673e97e23eac54620cfb913e5ce36c25 (v0.36.0)

No severity, scanner category, dev-dependency inclusion, ignore-unfixed setting, filtering, skip directory, security gate, image signature identity, SPDX verification, or MinIO image digest changes. No advisory exemption. The scanner update is not represented as a dependency remediation or proof that the Borsh feed mismatch disappears. Fresh filesystem and real S3 integration CI results are required.

The separately verified Borsh 0.10.4 guard and nine passing contract/regression tests are in PR #347. glib/rand findings remain unresolved. No production deployment or merge.
