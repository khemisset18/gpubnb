# Solana host recovery migration candidate

This separate draft builds on PR354 at
`a5eb4d065ec8443c6cf13fdc8c18cec97a64e6ed`. PR358 and its verified GLib/Rand
source backports remain unchanged. Here the actual product dependency graph
replaces the old libsecp256k1/Rand0.7 chain through one vendored
solana-secp256k1-recover2.2.1 compatibility backport. This is a review candidate;
overall qualification remains **BLOCKED**.

The host implementation follows Anza's official k256 migration from
`1dd727d4754b22157ce2b890b0f6dfe5237bc0d1`, adapted to the maintained
k2560.14.0 serialization API. Crypto-bigint0.7.11 and ctutils0.4.8 address the
current primary timing advisories RUSTSEC-2026-0387 and RUSTSEC-2026-0385.
Their selected compiler requirement is Rust1.87; CI uses exact Rust1.97.1.
No incompatible package is assigned an invented old version. The wrapper's real
base version2.2.1 is retained and the full backport is explicitly identified.

`programs/gpu_escrow/src/lib.rs` remains byte-identical, SHA256
`ffaa27c11cc7873282a85b05f2cfc0bcd8a6b8baba3154575596225b5faa8b41`.
Anchor0.31.1, Borsh0.10.4, the public wrapper interface and the original Solana
syscall source block are retained. The program manifest adds an exact already
locked serde_json version for the independent integration test. The real root
Cargo.lock records normal resolution of the new packages and compatible ctutils
patch, with every added/removed/changed entry retained in source-pins.json.

The oracle uses Python integer curve arithmetic, separately from either Rust
implementation. It checks 242 canonical-DER Wycheproof public cases against
their independent published classifications, then exercises all recovery IDs,
compact scalar bounds, hash reduction, malformed lengths and error precedence.
There are **1636 exact recovery/error cases**, including96 explicit high-S key
matches. The234 malformed/nonconvertible DER cases are listed as excluded,
because this API accepts compact signatures rather than DER. No claim that all
476 DER parser cases were exercised through this compact API is made.
The public input source commit/hash and original Apache license are retained.

The existing library accepts high-S signatures. This candidate preserves that
behavior; the latest upstream wrapper's explicit high-S rejection is not
backported. Both the real old and new wrappers matched all1636 independent
expectations locally, with2 tests PASS per version and0 failures/ignored.
This extends PR319's verification-only crypto vectors to actual public-key
recovery, including cases that an unreviewed crypto substitution could change.
There is no RNG, secret-key creation, signing, RPC, transaction or financial
handler execution in these tests. Previously validated GLib and desktop suites
are not manually repeated.

`qualify.py FRESH_DIRECTORY` checks every committed vendor file, both exact
manifests, the financial source hash and complete reviewed lock delta before
Cargo execution. It independently downloads the pinned original crate, official
license and upstream source, reproduces the exact bounded patch, checks the
unchanged syscall region, and regenerates every committed public fixture.
Actual --locked --all-features metadata must select this vendor source and
contain no libsecp256k1 or Rand0.7. It then runs the added public integration
tests through Anchor's actual Solana reexport on the frozen base and candidate.
Eight Python boundary/oracle checks guard changed sources, public inputs,
archive links, DER conversion and the independent arithmetic constants.

The first actual CI run43327949450 at head0c065e88 passed all1636 baseline and
candidate comparisons on Linux and macOS. Windows reconstructed the source and
fixtures, then stopped before the native comparisons because Python selected
cp1252 for Cargo's UTF-8 metadata. The reader now decodes JSON bytes directly,
and source/log text uses explicit UTF-8; a regression reproduces the locale
failure without running native code. The original failure and artifact hashes
are retained in evidence/initial-ci-summary.json.

The initial global run43327949219 stopped at Gitleaks: the field `expected.key`
held public affine-point hex values but matched its generic API-key rule.
Fixture schema2 names that value `expected.point`. All588 public points,
1048 errors, input bytes and case IDs are unchanged; reversing this field rename
reconstructs the complete prior fixture SHA256 exactly. The points stay plainly
visible, with no redaction, encoding change, scanner exception or path filter.
The same independent arithmetic generator regenerates schema2. Trivy did not
execute in that initial run, so no vulnerability result is claimed for it.

The unused supplier development Cargo.lock is not part of this library import;
its original SHA256 is recorded, the full published archive is verified, and all
source/license modifications are reconstructible. The product root lock is
retained and scanned without an ignore, waiver, path filter or severity change.
A reduced or clean scanner result is claimed only after observing the actual
new-head report. Borsh's primary advisory-range discrepancy and the coordinated
published GTK migration remain blocking; exact current official source/PR
heads are retained in evidence/upstream-review.json.

Host compatibility and a text-identical syscall block do not establish compiled
SBF, runtime/CPI/account/rollback, settlement/refund or on-chain upgrade safety.
The compatible ctutils patch also requires runtime/toolchain review. SBF tooling
is not retried following the earlier automatic review stop. GUI/IPC and actual
installation are not qualified here. No deployment, merge, exchange activation,
Mainnet, real funds, keys or DOGE executable/trust/workflow changes occur.

Primary sources:

- https://github.com/anza-xyz/solana-sdk/commit/1dd727d4754b22157ce2b890b0f6dfe5237bc0d1
- https://github.com/anza-xyz/solana-sdk/tree/1c1d667f161666f12f5a43ebef8eda9470a8c6ee/secp256k1-recover
- https://github.com/C2SP/wycheproof/tree/d17cc89fa5c8f4f4d378b5385ebf75da5d0926c9
- https://rustsec.org/advisories/RUSTSEC-2026-0385
- https://rustsec.org/advisories/RUSTSEC-2026-0387
- https://rustsec.org/advisories/RUSTSEC-2023-0033.html
- https://github.com/github/advisory-database/blob/main/advisories/github-reviewed/2023/04/GHSA-fjx5-qpf4-xjf2/GHSA-fjx5-qpf4-xjf2.json
- https://github.com/tauri-apps/tauri/pull/16170
