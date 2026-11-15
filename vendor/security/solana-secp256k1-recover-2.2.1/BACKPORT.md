# Host-only dependency backport for review

Original published solana-secp256k1-recover2.2.1, Apache-2.0, source commit
1c1d667f161666f12f5a43ebef8eda9470a8c6ee in anza-xyz/solana-sdk.
GPUbnb modifies the host-only implementation and both manifests on 2026-11-12.
It follows the official host k256 migration from commit
1dd727d4754b22157ce2b890b0f6dfe5237bc0d1 (SDK PR258), using maintained
k2560.14.0 and its to_sec1_point serialization API. The original Solana target
syscall block, public types, constants, signatures and error codes are retained.
The historical documentation outside the implementation is retained; its
standalone examples describe separately supplied libsecp256k1 dependencies.
Package version2.2.1 is the real upstream base, not a new upstream release.
The unused upstream development Cargo.lock is not imported. Its exact hash,
archive hash, modifications and all source/license hashes are recorded in
prototypes/solana-recovery-migration/source-pins.json. The product root lock is
resolved normally and remains subject to the strict scanner with no exemption.

The historical k2560.13 graph is avoided because crypto-bigint<0.7.6 has
RUSTSEC-2026-0387; ctutils is resolved to a published version>=0.4.4 for
RUSTSEC-2026-0385. Exact selected versions must be checked in the real lock.
This candidate must retain Solana2.2.1 host high-S acceptance and exact recovery
error precedence under the independent public arithmetic oracle. A successful
host comparison does not establish SBF/runtime financial compatibility.
