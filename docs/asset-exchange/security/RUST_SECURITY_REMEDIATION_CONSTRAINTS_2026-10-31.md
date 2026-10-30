# Rust security advisory path diagnostics (31 October 2026)

**No vulnerability is fixed by this change.** The existing all-severity Trivy gate must remain failing until actual safe dependency remediation is proven. The script is read-only and its green diagnostic job is never proof of financial or scanner qualification.

Active graph:
- borsh 0.10.4: gpu_escrow -> anchor-lang 0.31.1 -> borsh; RustSec lists ^0.10.4 as patched but GitHub/Trivy disagree. No local ignore or exemption is acceptable.
- rand 0.7.3: gpu_escrow -> anchor-lang -> solana-program -> solana-secp256k1-recover -> libsecp256k1 0.6.0 -> rand. Corrected rand starts with 0.8.6; forced incompatible crypto overrides are prohibited.
- glib 0.18.5: desktop -> tauri -> gtk 0.18 / webkit2gtk -> glib. Actual correction requires a coordinated GTK/Tauri/WebKit migration; isolated GLib probes do not fix the active graph.

CLI: node scripts/security/rust-advisory-graph.mjs --report Cargo.lock
Diagnostic exit 0 does not imply secure. --check exits 1 while a tracked version remains; malformed/ambiguous graphs exit 2. Keep Trivy authoritative. A package's absence does not prove runtime/ABI/GUI/financial compatibility.

Migration must preserve SBF/CPI/IDL/financial accounts and desktop Linux/Windows/macOS. Previous SBF execution stopped by automated cybersecurity review; no bypass. No changes to DOGE PR #320, trust inputs, wallet/signature, main or production.

Sources: https://rustsec.org/advisories/RUSTSEC-2023-0033.html ; https://github.com/advisories/GHSA-wrw7-89jp-8q8g ; https://github.com/advisories/GHSA-cq8v-f236-94qc
