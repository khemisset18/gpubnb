# Isolated Rust security migration prototype — not an integration approval

The owner's 29 October 2026 extended mission authorizes this isolated prototype.
This branch changes Anchor 0.31.1 to exact 1.2.2 through normal Cargo resolution;
`programs/gpu_escrow/src/lib.rs` remains byte-identical to base 470926f.
No active production branch, financial algorithm, key, signer, node, wallet,
transaction, deployment or activation is changed/executed.

## Actually executed host results

- Existing financial arithmetic tests: baseline seven (including its generated
  `test_id`), candidate six (Anchor 1.2.2 no longer generates that test).
- Three added regression tests pass on both, including an explicit pinned-ID
  check, exact Config 138-byte layout and discriminator/boolean/all truncations.
- Thirty independent Python SHA-256/little-endian fixtures match both actual Rust
  snapshots: two account layouts, eleven instruction encodings, ten events,
  Open account metadata, program ID and state values. This is stronger than
  merely comparing the two builds with each other.
- All eleven instructions, account/type metadata, ten IDL events and errors
  compare semantically. The raw IDL print fragments are **not identical**:
  old Anchor double-JSON-encodes the address section. `idl.diff` preserves this;
  exactly one asserted decode yields the same pinned address. No other IDL
  normalization was applied. Full CLI/client migration remains NOT TESTED.
- Standalone libsecp256k1 0.6.0 vs 0.7.2 verification: all 476 pinned public
  Wycheproof vectors PASS with identical outcomes. No keys/signatures were
  generated and no RNG used by the probe. This is not a Solana syscall test.
- Candidate active Cargo.lock contains borsh 1.8.0, no borsh 0.10, no rand 0.7,
  and no libsecp256k1. GLib 0.18.5 remains through the desktop optional graph.

## Remaining validation / blockers

SBF build/runtime, actual account privilege/ownership/reentrancy and CPI behavior,
TypeScript Anchor client compatibility, full Solana instruction signatures,
on-chain upgrades, compiled program equivalence and independent security review
are **NOT TESTED**. This branch is a prototype, not a drop-in financial migration.
Neither source equality nor host tests proves these missing properties.
Anchor1.2.2 also removes legacy IDL management instructions in favor of Program
Metadata and introduces generated account-safety semantics. Our business ABI
fixtures do not establish equivalence of that entire generated dispatcher.
The official Anchor IDL migration documentation must be reviewed with clients.

GLib official backport is tested in `glib/`: optimized baseline SIGSEGV(-11),
backport3072iterator comparisons PASS with real GLib2.80.0. A separate synthetic
GTK3 Adjustment/GObject native component probe passes four bounds/state checks.
Neither proves the RustGTK/Wry/Tauri GUI/event loop or complete native packaging.
The original0.18.5 version is preserved, so Trivy remains blocking; no exemption
or version spoof is proposed. See glib/README.md for exact provenance/limits.

`evidence/` contains actual outputs and comparisons, not chain qualification.
Official Rust 1.97.1 components were verified against the release manifest.
The local sandbox required GCC/bfd linker flags because bundled LLVM could not
resolve `/proc/self/exe`; this is a build-environment choice, not a code waiver.

## Reproduction

`python3 prototypes/rust-security/run_anchor_probe.py NEW_DIRECTORY` reproduces
the host comparisons from the immutable base source and hash-pinned public
vectors. `glib/run_probe.py` repeats the native negative control/backport.
The isolated CI workflow runs these with Rust1.97.1; Ubuntu native development
metadata is downloaded at exact retained hashes, extracted only to runner temp.
A green prototype workflow proves only these named host/native diagnostics.
The repository-wide Trivy gate is unchanged and still blocks the GLib finding.
