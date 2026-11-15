# Preserve the GLib correction when integrating the Rand migration

PR363 at `61120168eddf2f39e9874f28406f78b905c7edde` removes Rand0.7 but still
selects the unpatched published GLib0.18.5. This candidate reuses **only the GLib
backport** from PR358 at `d09996050e5aebc1be8db8698c38d7ea991929fa`.
The earlier branch, Rand backport and their evidence remain intact in Git history.
No Rand0.7 package, override, test dependency or obsolete supplier lock is imported.

The active root patch selects the complete121-file GLib crate, including its
original manifests, source metadata, COPYRIGHT and LICENSE. Its authentic
package version0.18.5 and all dependencies remain unchanged. Cargo.lock loses
only GLib's registry source/checksum, as required for a local source patch.
The only source change against the checksum-pinned published archive is the two
out-pointer mutability corrections in `src/variant_iter.rs`. The complete fixed
file is byte-identical to the official gtk-rs commit
`b5a4071e439bef2b5eea76c3aa25e5ae84839e34`.

`prepare.py FRESH_DIRECTORY --prepare-only` independently downloads the original
archive, verifies its checksum and source commit, reapplies the exact bounded
patch and compares **all121 source/license files**. It also refuses unrelated
active manifest/lock changes or financial/desktop source changes. The additional
Borsh test from PR347 may be present only with its exact reviewed source hash;
absence here does not count as running that test. Eight preparation regressions
include source selection, archive boundaries and refusal of Rand0.7 reintroduction.

The full runner adds just one GLib-only regression package in a disposable
worktree. It checks actual all-feature Cargo metadata before executing an
optimized2080-value iterator comparison, existing Anchor/public-recovery tests,
desktop host tests and the full Linux Tauri GTK/WebKit compile. The original
recovery workflow also runs on Linux, Windows and macOS with the combined lock.
The complete reviewed lock delta and all GLib source hashes remain enforced by
the recovery runner. No financial source, account format or syscall is changed.

## Remaining blockers

This is a compatible source correction, **not a clean scanner result**.
The existing strict all-severity scanner and its gate are unchanged.

| Dependency | Current primary evidence | Status |
| --- | --- | --- |
| GLib0.18.5 | Official fixed iterator source is reconstructed; published Tauri2.12.5 still requires GTK^0.18. The coordinated Tauri/Wry/Tao migration remains unpublished. Trivy's version range still reports the authentic backport. | BLOCKED |
| Borsh0.10.4 | RustSec explicitly marks^0.10.4 patched; GitHub's machine range still ends at1.0.0-alpha.1 despite `last_known_affected_version_range <=0.10.3`. Anchor0.31.1 and0.32.2 require^0.10.3. No advisory rewrite or financial framework migration is made. | BLOCKED |
| Rand0.7 | Removed by the retained PR363 migration; both the root lock and actual all-feature metadata must continue to exclude it. | Exact candidate scanner evidence required |

The original PR363 run43484094455 completed on Linux and Windows, with2 tests
and1636 exact public recovery cases per baseline/candidate on each platform.
Its macOS job is **CANCELLED**, not a current-head PASS. Scanner run43484094122
reported exactly Borsh and GLib in the root Cargo.lock. Those artifacts were
downloaded and SHA-checked again on2026-11-15; they are historical evidence for
that exact head, not evidence for this combined candidate.

Current upstream references and exact source blobs are retained in
`evidence/current-review-20261115.json`. New candidate evidence must be checked
at its own HEAD and synthetic PR execution SHA before making a result claim.
The local environment has Rust1.97.1 but no native GLib/GTK/WebKit development
packages, so full Linux desktop compilation is delegated to the existing
authorized automatic CI workflow. SBF/runtime/CPI/account/rollback, GUI/IPC,
physical machines, installation and external audit remain NOT_TESTED here.
Overall qualification stays BLOCKED. No signing, blockchain node, mining,
transaction, deployment, merge or production activation is performed.
