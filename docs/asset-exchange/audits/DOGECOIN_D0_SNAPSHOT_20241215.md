# D0 snapshot correction — qualification remains BLOCKED

Following user authorization to proceed, the build snapshot changes explicitly from 20241212T000000Z to 20241215T000000Z. Source commit, official archive hash, both official manifests and Ubuntu signing keys remain unchanged.

Probe run 40803717749: only December 15 passed all candidate checks. Artifact 12867247409 SHA256 ef9a071aaf928953dc528a680507fbbd6d3e4dafbb63a470a73247de6f5d7c88 was downloaded and verified. Four InRelease signatures validate against the captured existing Ubuntu keyring; 14 package indexes match signed hashes and sizes; all 323 KunNw0n package identities, versions, architectures and SHA256 values are present. The included offline verifier repeats these checks. Availability does not prove installed manifest equality or binary reproducibility.

The comparator now rejects any other snapshot identifier, even a syntactically valid one. Failed builds preserve the x86_64 archive under diagnostics for offline comparison. Two independent builds are triggered on this isolated branch. No merge, node execution, Mainnet, funds or financial activation. D1-D9 remain blocked until D0 passes. Global dependency/security failures remain unwaived.
