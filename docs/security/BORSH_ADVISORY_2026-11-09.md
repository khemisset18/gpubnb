# Borsh advisory reconciliation — 9 November 2026

The retained Trivy finding for borsh 0.10.4 / GHSA-fjx5-qpf4-xjf2 conflicts with the current primary advisory and package implementation. It must not be described as a demonstrated unresolved vulnerability merely because it appears in the scanner output.

RustSec RUSTSEC-2023-0033 lists patched ranges >=1.0.0-alpha.1 and ^0.10.4. The GitHub advisory lists affected versions <=0.10.3. The previous migration report's statement that only 1.x is corrected was incomplete and is superseded for this advisory.

Sources checked directly:
- https://rustsec.org/advisories/RUSTSEC-2023-0033.html
- https://github.com/advisories/GHSA-fjx5-qpf4-xjf2
- https://static.crates.io/crates/borsh/borsh-0.10.4.crate

The downloaded package SHA256 115e54d64eb62cdebad391c19efc9dce4981c690c85a33a12199d99bb9546fee exactly matches Cargo.lock. Its src/de/mod.rs rejects Vec<T> when size_of::<T>() is zero before reading the length or invoking element deserialization. The code path is present in the installed package, not inferred from a later version's documentation.

New integration regressions use AnchorDeserialize from the actual anchor-lang dependency, with a non-Copy/non-Clone zero-sized type. They require InvalidInput at counts 0, 1, 1000 and u32::MAX and zero element deserializer calls; a separate ordinary u16 vector checks serialized-byte compatibility and truncated-input rejection. Runtime status is NOT_TESTED until CI executes the Rust tests; Cargo is unavailable in the local container.

No dependency or lockfile change is necessary to add these tests. No advisory ignore, VEX exemption, severity downgrade, scanner filter or security gate change is made. A failing Trivy gate stays FAIL while the contradictory feed result is investigated. glib and rand remain separate unresolved findings. This is a correction of evidence and a regression test, not a claim that the full Rust dependency tree is safe.

Official registry dependency queries also confirm anchor-lang 0.31.3 and 0.32.3 still require borsh ^0.10.3, while 1.2.2 requires ^1.5.7 and changes the Solana crate family. A major financial-contract migration should not be undertaken solely to eliminate this already-corrected ZST issue; rand may still require a separate parent migration. Raw relevant dependency constraints are retained in evidence/borsh-20261109/anchor-constraints.json.
