# GLib official backport — isolated native prototype

**Functional native probe PASS; global security remediation BLOCKED.**

The official registry glib0.18.5 archive is verified against Cargo's SHA-256.
Only the exact two-line fix from gtk-rs commit
`b5a4071e439bef2b5eea76c3aa25e5ae84839e34` is applied. The entire resulting
variant_iter.rs matches the official fixed file, Git blob
`e0997f651b103f7b198e528ee41137ad374e19b8`. MIT notice/copyright is preserved.
This removes passing an immutable local pointer to a C varargs output parameter.
No crate version is changed or scanner exemption introduced.

Actual optimized tests on native GLib2.80.0:

- Unmodified0.18.5 baseline: **FAIL**, process SIGSEGV(-11), core disabled,
  256MiB address-space cap and15second timeout; this is a preserved failing
  negative control, never called a baselinePASS.
- Official-backport candidate: **PASS**,3072 forward/reverse/mixed iterator
  comparisons (four public arrays repeated256times) and wrong-type rejection.
- Actual dynamic linkage paths, resolved library hashes and runtime version
  are recorded in `../evidence/glib-native-*` and the run JSON/logs.

The two-line fix changes no public ABI or Rust type version. It is only a focused
FFI regression probe: GTK widgets, WebKit, the Tauri event loop, complete native
packaging and Windows are **NOT TESTED** by this probe. The backport is not wired
into the active desktop tree. Tauri/GTK's selected0.18.x ecosystem still lacks a
released compatible fixed glib version; Trivy must remain blocking on0.18.5.
Upgrading just the label or excluding this graph would misrepresent the result.

`run_probe.py NEW_DIRECTORY` downloads only the explicitly hash-pinned official
crate/fix and repeats the native builds/tests. It needs Rust and system GLib
headers/pkg-config; no wallet, node, signer, transaction or external service.
The actual scratch test used verified official Ubuntu Noble dev packages,
extracted without system changes, plus the host's real GLib runtime. Their
package hashes/provenance and toolchain hashes are retained in evidence.
Undefined behavior need not crash with every compiler: a baseline run succeeding
is reported as such and never interpreted as proving the old code safe.
GLib runtime distribution has separate LGPL obligations noted by upstream.
