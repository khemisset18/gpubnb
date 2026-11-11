# Compatible Rust backports in the actual workspace

This isolated candidate is based on PR354 at
`a5eb4d065ec8443c6cf13fdc8c18cec97a64e6ed`. It reuses the exact GLib fix and
source/license evidence reviewed in PR319 at
`35fb07cbc1487d05f5f38d0450e9dbdb0a63301e`, then exercises a new integration
boundary: the full current workspace graph with its original package versions.
The active application Cargo files and financial implementation stay unchanged.
No old vulnerable GLib or Rand probe is executed.

`prepare.py FRESH_DIRECTORY` downloads two checksum-pinned published crate
archives, validates their source commits, applies the exact bounded patches,
and refuses unexpected file changes. It makes a disposable Git worktree,
changes only the source of glib0.18.5 and rand0.7.3, and adds one regression
package. Cargo must accept the resulting lock with `--locked`; all original
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

All three package versions remain visible to the unchanged strict Trivy gate.
An actual backport regression PASS must never be described as a clean scanner
result. No ignored advisory, reduced severity, renamed package or version spoof
is added. The technical status remains BLOCKED until the exact CI evidence,
full required platform/runtime coverage and external review support promotion.
