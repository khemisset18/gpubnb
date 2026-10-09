# Dogecoin D0 Internal Reproducible Build Plan

Status: EXECUTABLE QUALIFICATION HARNESS / FAIL-CLOSED / NO SETTLEMENT ACTIVATION / NO BINARY EXECUTION

## Purpose

This gate independently reproduces the Dogecoin Core v1.14.9 Linux release artifact after upstream prebuilt signer provenance failed gpu.k.p2p D0 policy.

It does not execute Dogecoin, start a node, use Mainnet, use real funds, or promote any asset capability.

The controlling acceptance policy is `DOGECOIN_D0_TRUST_POLICY_V1.md`.

## Trust pins

- Dogecoin repository: `https://github.com/dogecoin/dogecoin.git`
- source commit: `e0a1c157791544e818c901bd9341896965afbf9d`
- Gitian Linux descriptor: the exact file contained in that source commit, byte-for-byte unchanged
- Gitian builder commit: `41c325d2f14147e8028fce9a5edd26e7adad30a4`
- LIEF wheel SHA-256: `c848aadac0816268aeb9dde7cefdb54bf24f78e664a19e97e74c92d3be1bb147`
- observed official Linux x86_64 SHA-256: `4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8`
- Ubuntu Focal image: Canonical's verified Amazon ECR publication, resolved to an immutable RepoDigest before build and compared across replicas

Historical dependency download locations are transport only. Dependency integrity is determined by the hashes pinned in Dogecoin's exact `depends` tree.

## Source-cache preparation

Some historical upstream URLs used by Dogecoin Core v1.14.9 no longer serve their original files reliably.

The qualification harness therefore prepares the Gitian `cache/common` before compilation:

1. preloads explicitly recovered historical archives only when their expected Dogecoin hash is known;
2. runs Dogecoin's own `depends download-one` for every Linux host in the upstream descriptor;
3. passes a fallback mirror only to this pre-download phase;
4. relies on Dogecoin's pinned SHA-256 values to accept or reject every source file;
5. records a deterministic SHA-256 manifest of the resulting source cache.

No fallback URL is injected into or otherwise added to the Gitian descriptor.

## Build design

Two independent GitHub-hosted runners build without shared build caches.

Each runner:

1. checks out the exact Dogecoin source commit;
2. checks out the exact Gitian builder commit;
3. verifies the LIEF input SHA-256;
4. verifies that the Gitian descriptor blob is exactly the blob committed at the pinned Dogecoin source commit;
5. records the descriptor SHA-256 without modifying it;
6. prepares and hashes the depends source cache;
7. resolves Canonical Ubuntu Focal to an immutable image digest;
8. constructs the Gitian Docker base from that digest;
9. executes the full upstream Linux Gitian descriptor, including i686, x86_64, ARM and AArch64 hosts;
10. preserves the upstream descriptor's security/symbol checks;
11. records the x86_64 release archive and build evidence without executing any produced binary.

## Comparison gate

The compare job fails closed unless:

- both independent x86_64 artifacts exist;
- both artifacts are byte-for-byte identical;
- their SHA-256 equals the observed official release SHA-256 exactly;
- source commit, Gitian builder commit and Canonical Focal digest agree;
- the descriptor SHA-256 agrees and both replicas attest that it was not modified;
- the complete depends source-cache manifest agrees;
- required recovered-input hashes agree;
- neither replica executed the produced binary;
- archive paths and link targets cannot escape the archive root;
- device nodes, FIFOs and unsupported member types are rejected.

The verifier produces archive-member evidence, SPDX 2.3 SBOM evidence and internal provenance.

GitHub artifact attestations are generated for both the reproduced archive and its SBOM only after the comparison gate passes.

## D0 decision

If every requirement in `DOGECOIN_D0_TRUST_POLICY_V1.md` passes, the evidence record may state:

`PASS_INTERNAL_REPRODUCIBLE_BUILD`

That status means only that this internally reproduced Dogecoin Core toolchain is acceptable for subsequent isolated D1-D9 qualification.

It does not resolve the upstream prebuilt GPG provenance issue and does not authorize:

- production settlement;
- Mainnet;
- real funds;
- `automaticSettlementSupported=true`;
- registry promotion;
- BCH progression before the D0 evidence itself is complete.

Any mismatch remains BLOCKED.
