# Supplemental source/tooling inspection — no SBF contract result

**NOT TESTED: SBF contract compilation/runtime.** The supplementary worker was
interrupted by an automated possible-cybersecurity-risk content block during
SBF tooling/preflight. The unfinished extraction/compiler observation is not
reported as a contract failure or PASS. No node, wallet, keypair generation,
signer, transaction, deployment or attempt to bypass that block occurred.

Safe read-only checkpoint: the official Anza platform-tools v1.57 archive is
531380716bytes and matches GitHub release SHA256
b0f7af104adf726fff2a6a09ea2eb2f2d2965c92295f4d7388c08d140e0c2b00.
That verifies an input archive, not working extraction or an SBF build. The
standard cargo-build-sbf post-processing can create a keypair; it was not run.

The already-produced Rust1.97.1 HOST macro expansions are retained losslessly.
RUSTC_BOOTSTRAP=1 was used only for the unstable read-only -Zunpretty=expanded
inspection in isolated fresh target caches, never to waive a release check.
The financial source is unchanged, but generated behavior visibly differs:
legacy IDL tag sites2→0, duplicate-mutable-account hooks0→9 and constraint
sites0→7. This is direct evidence that byte-identical business source and host
ABI data do not establish dispatcher/account-safety equivalence. Counts identify
code sites; they are not executed security guarantees or vulnerabilities.

Exact input/output hashes, original byte lengths and compressed hashes are in
PREPARED_TOOLING_AND_SCOPE.json. Anchor-generated code is Apache-2.0; standard
license text is retained in ../crypto/UPSTREAM_LICENSE. Anchor sources/versions
are fixed by the baseline and candidate Cargo locks. These are audit artifacts,
not a new runtime dependency. No source or trust parameter is promoted.
