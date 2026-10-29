# Additional compatible Trivy fixes

Status: actual modified files scanned; three unresolved occurrences continue to
block full repository qualification. This supersedes the initial nine-finding
count in CORE_SECURITY_VALIDATION_2026-10-29.md, which preserves the prior scan.

| Component | Actual change | Validation |
| --- | --- | --- |
| PyNaCl | 1.5.0 → 1.6.2 in root requirements, Agent requirements and Agent pyproject | Installed package 1.6.2; actual Agent suite 447 tests, 446 pass, one pre-existing Rust-ticket fixture skip; two added RFC8032/signature/point-validation regressions pass |
| Rustls | 0.23.43 → 0.23.46, compatible 0.23 floor and Cargo-generated exact lock update | All-target locked cargo check passes; gateway tests with actual Redis, cross-language ticket compatibility, Clippy and container validation run in dedicated CI |

Cargo changed only Rustls version/checksum; its dependency set is unchanged.
No TLS policy, key handling, signing logic or financial code changed. No
unsafe-code allowance, exception, ignore entry or test bypass was added.

Local Rust's default lld wrapper cannot resolve /proc/self/exe in this sandbox.
The initial check failed for that environment reason. Repeating the diagnostic
compile with the existing system bfd linker succeeded. The full default-toolchain
checks remain mandatory on the normal CI runner; the local workaround changes
no repository build flags or acceptance criteria.

Actual Trivy 0.76.1 scan now explicitly includes development dependencies, all
severities, and unfixed findings. Result: three occurrences in root Cargo.lock,
two MEDIUM and one LOW; no HIGH/CRITICAL. Both npm trees and both Python
requirements plus gateway Cargo.lock have zero findings in this scan. Full
report is retained compressed with uncompressed digest in tested-inputs.json.
The report-generating scanner exit 0 is not a security PASS. CI remains blocked
on every residual finding.

## Exact remaining roots and compatibility boundary

- `borsh 0.10.4`, GHSA-fjx5-qpf4-xjf2 (MEDIUM): direct dependency of Anchor
  0.31.1 and several Solana 2.x crates in the escrow contract graph. Trivy's
  fixed range starts at 1.0.0-alpha.1, outside the selected 0.10 API. Replacing
  its lock entry with a 1.x crate would violate the dependency contract. A
  wider Anchor/Solana serialization/ABI review and migration is required; no
  compatible minimal correction is claimed.
- `glib 0.18.5`, GHSA-wrw7-89jp-8q8g (MEDIUM): GTK3 desktop graph, including
  gtk/gdk/gio/atk/pango/webkit2gtk through the optional Tauri runtime. Fixed
  0.20 is outside the current 0.18 ecosystem. The shared Cargo.lock records
  that graph even when the desktop runtime feature is off. It is not excluded.
- `rand 0.7.3`, GHSA-cq8v-f236-94qc (LOW): libsecp256k1 0.6.0 in the Solana
  graph; the fixed branches reported are 0.8.6/0.9.3/0.10.1, outside 0.7.
  No global force override or financial cryptography migration was applied.

The exact reverse edges from the real lockfile are retained in
`evidence/security-followup-20261029/remaining-dependency-origins.json`. These
remaining issues require a concrete wider compatibility migration and review;
they are not declared inapplicable, accepted or fixed by this work.

## Integration results and separate infrastructure failure

Security commit f0ef7390bb7fad81f319cfb78d23707a026bc799 CI run 40891988098
proves Node 22 actual installs/audits, API build/strict TypeScript, isolated
PostgreSQL/Redis readiness, 699 API passes / 2 pre-existing S3 skips, Agent 444
passes / 1 pre-existing missing Rust-ticket fixture skip, 7 escrow unit tests,
production guards and Gitleaks. Asset Exchange foundation run 40891988124 passed.
Those results do not include a Solana validator or production integration.

The separate S3 workflow run 40891988421 failed before tests: Docker could not
pull `minio/minio:latest` (pull denied / repository unavailable, exit 125).
This is an actual infrastructure blocker, not evidence of a Zod/Jayson failure.
The S3 tests were not executed. No unreviewed image/provider substitution or
success-by-skip change was applied. A reviewed, available fixture image with
pinned provenance is needed before that integration can be qualified.
