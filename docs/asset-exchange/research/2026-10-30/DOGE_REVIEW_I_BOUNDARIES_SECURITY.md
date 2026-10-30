# Review I: bounded shared validation and remaining Rust security constraints

## Confirmed interface defects and correction

The shared JavaScript canonicalizer bounded each container/depth, but not total
visits, key size or aggregate text. Small shared object graphs could therefore
expand exponentially before hashing/schema rejection. It now bounds traversal
to32768 visits, keys256 characters and aggregate text2MiB, retaining existing
per-field/container/depth checks. The text allowance covers the protocol store's
bounded event history; it is not a claim of unlimited recovery capacity.

Eight focused tests now pass; three fail against the exact original Git source.
The before-final-cases log and provenance record reproduce the current tests
against that original module with only import URLs redirected. Five additional
guards already worked (exact digests/integers/newline rejection and normal hash
bytes); those were tested and preserved, not claimed as newly fixed bugs.
All six chain descriptor boundaries reject malformed identities, and the existing
thirty-direction tests still keep every financial route disabled.

Actual full Foundation251PASS,0FAIL/skip;50 source files syntax checked.
Python D2 now74PASS, including a real FIFO read rejected without blocking the CLI
and an oversized-file refusal; no native code is loaded. A final
format-only indentation cleanup was separately syntax checked. Historical hash
vectors, getter/prototype/array controls, journal replay and recovery tests pass.
No address-format, finality, PDA, signature or native capability is inferred from
structural membership in the catalog. D2 and all financial routes stay BLOCKED.

Original logs/source hashes are in evidence/review-i/. A known public fixture
directory left by a local test interruption was positively identified against
configFixture(), then preserved by rename outside the worktree, not deleted.
Its public file hashes and preserved path are recorded; no other worktree moved.

## Active Rust graph: reusing #319 instead of repeating its experiments

Read-only Cargo.lock analysis confirms exact active parents and one root path
per finding in active-rust-paths.json (lock SHA256 recorded). No Cargo build,
upstream unsafe-version experiment, SBF retry or dependency override was run.

| Finding | Active shortest path | Verified reviewed correction boundary |
| --- | --- | --- |
| borsh0.10.4 MEDIUM | gpu_escrow→anchor-lang0.31.1→borsh | RustSec's primary advisory lists ^0.10.4 as patched; GitHub machine range still fixes only1.0.0-alpha.1 while its informational affected range ends0.10.3. #319 already inspected the published decoder/backport. This does not authorize dismissing the active scanner finding |
| rand0.7.3 LOW | gpu_escrow→anchor-lang0.31.1→solana-program2.3.0→solana-secp256k1-recover2.2.1→libsecp256k1 0.6.0→rand | The reviewed corrected branches are outside the selected0.7 contract. #319's newer Anchor/Solana host graph removes the old dependency, but SBF/CPI/runtime/financial compatibility remains unqualified. No forced crypto override |
| glib0.18.5 MEDIUM | gpubnb-host-desktop→tauri2.11.5→gtk0.18.2→glib, plus12 direct parents | #319 verifies maintained GTK/GLib references and a standalone GLib probe. Its reviewed newer Tauri/Wry/Tao/WebKit manifests still select the old GTK/GLib family. A coordinated GUI migration remains necessary; adding a second GLib is not removal of the first |

The live primary Borsh advisory texts were checked again without rerunning an
experiment: RustSec advisory-db crates/borsh/RUSTSEC-2023-0033.md and GitHub's
advisory-database GHSA-fjx5-qpf4-xjf2 JSON still show that discrepancy. The detailed
source/archive/checksum and host-probe evidence remains at immutable #319 commit
35fb07cbc1487d05f5f38d0450e9dbdb0a63301e, constraints/REVIEW_2026-10-30.md,
ADVISORY_DISCREPANCY.json and PUBLISHED_GTK_REVIEW.json. Those research results are
not substituted for the unchanged active lock or for native financial safety.

No compatible direct dependency fix was demonstrated in this scope. Cargo.lock,
financial/Anchor/GTK sources and the other agent's worktree remain unchanged.
Trivy stays blocking; no waiver, severity exclusion, invented fixed version or
test suppression was added. The old S3 API and Agent/Rust skipped paths remain
NOT TESTED, not PASS; unavailable external test services/binaries are not replaced
by mocks presented as integrations. Latest CI results must be linked to the final
head rather than inferred from these local software checks.
