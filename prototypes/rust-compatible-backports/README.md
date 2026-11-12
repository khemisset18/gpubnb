# Compatible Rust backports in the actual workspace

This isolated candidate is based on PR354 at
`a5eb4d065ec8443c6cf13fdc8c18cec97a64e6ed`. It reuses the exact GLib fix and
source/license evidence reviewed in PR319 at
`35fb07cbc1487d05f5f38d0450e9dbdb0a63301e`, then exercises a new integration
boundary: the full current workspace graph with its original package versions.
The active Cargo manifest now selects the two committed vendored backports through [patch.crates-io]. Cargo.lock changes only their source identities/checksums; all package names and versions and the financial implementation stay unchanged.
No old vulnerable GLib or Rand probe is executed.

`prepare.py FRESH_DIRECTORY` downloads two checksum-pinned published crate
archives, validates their source commits, applies the exact bounded patches,
and refuses unexpected file changes. It proves that all175 committed vendor files match independently reconstructed, checksum-verified backports. A disposable Git worktree uses those actual active sources and adds one regression package; it does not substitute an unreviewed source through a temporary override. Cargo must accept the resulting lock with `--locked`; all original
package identities must remain. The test-only Rand log feature is deliberately
enabled, including its already-locked log dependency.

The GLib file matches the complete official fixed file from
gtk-rs/gtk-rs-core `b5a4071e439bef2b5eea76c3aa25e5ae84839e34`.
Rand removes the three reseeding log callbacks following the official
rust-random/rand fix `605731b59aabb38338e65f2a6a7ba8a9e480d00d` and released
0.8.6 `5309f25bb5e7d21ac01c5b6f476badd06f9cdc3f`. This narrow0.7 backport
preserves its existing reseeding-failure behavior; it does not silently adopt
the0.8 change to panic on entropy failure. Algorithms, versions and public
interfaces are retained. These are candidates for review, not new upstream releases.

New optimized regressions cover exact mixed-end iterator values against an
independent deque, nth/nth_back/exact-size boundaries, a calibrated reentrant
logger across1MiB of ThreadRng output, controlled reseeding failure with no
logging callback, and the published zero-key ChaCha20 known answer. The same
temporary workspace then runs actual Anchor host tests, desktop native tests,
and the full Linux Tauri desktop-runtime compilation against GTK/WebKit.
None of this is an SBF/runtime financial qualification or a GUI/IPC/installer test.

The existing Borsh0.10.4 package already contains the published ZST correction,
as actually tested in PR319. RustSec still lists^0.10.4 as patched while the
GitHub machine range flags it; that discrepancy remains blocking and is not
converted into an exemption. No unnecessary repeat of its earlier probe occurs.

All three package versions remain authentic. The unchanged strict Trivy gate must be observed on the exact integration head; no clean-scanner result is inferred from changing a source origin.
An actual backport regression PASS must never be described as a clean scanner
result. No ignored advisory, reduced severity, renamed package or version spoof
is added. The technical status remains BLOCKED until the exact CI evidence,
full required platform/runtime coverage and external review support promotion.

| Advisory | Exact source disposition | Actual verification | Active scanner disposition |
| --- | --- | --- | --- |
| GHSA-wrw7-89jp-8q8g / GLib0.18.5 | Official fixed iterator file from `b5a4071e439bef2b5eea76c3aa25e5ae84839e34`, selected through the active patch path | 2080 exact value comparisons; full Linux GTK/WebKit Tauri compile PASS on run43115991870 | Still reported in the real root Cargo.lock; BLOCKED |
| GHSA-cq8v-f236-94qc / Rand0.7.3 | Removal of the three reseed log callbacks from `605731b59aabb38338e65f2a6a7ba8a9e480d00d`, selected through the active patch path | Calibrated reentrant logger, 1MiB output, controlled reseed failure and ChaCha20 known answer PASS on run43115991870 | Still reported in the real root Cargo.lock; BLOCKED |
| GHSA-fjx5-qpf4-xjf2 / Borsh0.10.4 | Published decoder already contains the ZST correction; no package or advisory metadata rewritten | Bounded native evidence retained in PR319; 7 current Anchor host tests PASS on run43115991870 | RustSec/GitHub machine-range discrepancy; still reported in the real root Cargo.lock; BLOCKED |

The complete published Rand archive contains an old development/benchmark
`Cargo.lock` that Cargo does not consult for this workspace dependency. The first
active integration scan (run43115991902, head e4fb65cc) reported the three root
advisories above plus obsolete bumpalo2.6.0 and a second Rand entry in that unused
supplier lock. The source import now omits only this unused development snapshot,
whose exact original SHA256 is recorded in `source-pins.json`. Every Rust source,
manifest and license remains byte-for-byte verified against the complete archive
and the two stated patches. The application's real `Cargo.lock` and the scanner
configuration stay intact. This import boundary does not fix an active bumpalo
dependency, waive an advisory, or establish a clean product scan. The three root
advisories remain blocking until an actual subsequent scan establishes otherwise.

The first active integration workflow43115991870 passed on synthetic PR revision
`1a120bc2a776a225a56d3e85644f84e35219d682` for head
`e4fb65ccc08975f0079aa1e40128428dc97d7e4e`: 3 optimized backport regressions,
7 Anchor host tests, 506 desktop host tests and the full Linux Tauri compile.
These native tests are retained as evidence rather than repeated locally for a
supplier lock import change. The bounded evidence summary records exact artifact
and log hashes, selected active paths, test counts and the actual five-finding
scanner result before this import correction. GUI/IPC and SBF runtime remain
NOT_TESTED; overall qualification remains BLOCKED.
