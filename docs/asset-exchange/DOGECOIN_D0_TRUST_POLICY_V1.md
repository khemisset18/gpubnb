# Dogecoin D0 Trust Policy V1

Status: SPECIFIED / FAIL-CLOSED / NO MAINNET / NO AUTOMATIC SETTLEMENT

## Purpose

Dogecoin D0 establishes whether gpu.k.p2p may use a specific Dogecoin Core toolchain for isolated qualification. It does not activate settlement.

The upstream v1.14.9 prebuilt signer provenance remains blocked under the 2026-10-08 review. This policy defines an independent source-rebuild route that can satisfy D0 without treating the problematic upstream GPG signatures as trusted evidence.

## Trust root

The source-rebuild route binds to all of:

- official upstream repository: `https://github.com/dogecoin/dogecoin.git`;
- source commit: `e0a1c157791544e818c901bd9341896965afbf9d`;
- Gitian descriptor contained in that exact source commit;
- pinned Gitian builder commit: `41c325d2f14147e8028fce9a5edd26e7adad30a4`;
- immutable Ubuntu Focal container digest resolved and recorded before build;
- LIEF wheel SHA-256 `c848aadac0816268aeb9dde7cefdb54bf24f78e664a19e97e74c92d3be1bb147` from the upstream release build script;
- LIEF transport may use the PyPI file CDN only when the downloaded bytes match that exact pinned SHA-256; transport location is not a trust substitute;
- qrencode 3.4.4 may be preseeded from an independent HTTPS source mirror only when it matches the exact Dogecoin depends SHA-256 `efe5188b1ddbcbf98763b819b146be6a90481aac30cfc8d858ab78a19cde1fa5`; mirror identity is transport evidence only;
- zlib 1.3 may be preseeded from the official zlib HTTPS fossils directory only when it matches the exact Dogecoin depends SHA-256 `ff0ba4c292013dbc27530b3a81e1f9a813cd39de01ca5e0f8bf355702efa593e`;
- observed official x86_64 release archive SHA-256 `4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8`.

The security assumption is explicit: gpu.k.p2p trusts the official GitHub repository/commit identity as the source root for this internal qualification route. It does not reinterpret an expired/revoked OpenPGP signature as valid.

## Required independent evidence

D0-SOURCE-REBUILD may be PASS only when two clean GitHub-hosted build jobs independently:

1. fetch the exact Dogecoin source commit;
2. fetch the exact pinned Gitian builder commit;
3. resolve Ubuntu Focal to an immutable image digest before building;
4. verify the pinned LIEF wheel hash;
5. use the upstream Gitian Linux descriptor from the pinned Dogecoin commit without modification;
6. build using Gitian Docker isolation;
7. do not execute the resulting release binary;
8. produce byte-for-byte identical x86_64 release archives;
9. produce the observed official x86_64 SHA-256 exactly;
10. pass archive path/link safety inspection;
11. produce an SPDX SBOM and source/build identity evidence;
12. receive gpu.k.p2p GitHub attestation for the internally reproduced artifact and SBOM.

Any mismatch is BLOCKED, not a warning.

## D0 decision

Overall D0 may be marked `PASS_INTERNAL_REPRODUCIBLE_BUILD` only after all required independent evidence above is green.

This status means only that the internally reproduced Dogecoin Core binary is accepted as a tool for subsequent isolated D1-D9 qualification.

It does NOT mean:

- Dogecoin settlement is secure;
- Dogecoin is production-ready;
- the upstream prebuilt signer-provenance issue is resolved;
- Mainnet is authorized;
- real funds are authorized;
- `automaticSettlementSupported` may be set true.

## Support-policy discrepancy

The upstream discrepancy between the release page and the security-policy support table remains a governance/maintenance risk. It must stay recorded as residual risk even if source-rebuild D0 passes.

## Stop conditions

Fail closed if any of the following occurs:

- source commit differs;
- Gitian descriptor differs from the pinned source tree;
- Gitian builder commit differs;
- required dependency hash differs;
- two build outputs differ;
- output differs from the observed official hash;
- final binary is executed during D0;
- archive contains unsafe paths, device nodes, FIFOs, or escaping links;
- SBOM/source binding cannot be generated;
- internal provenance attestation cannot be produced.

Until D0 passes under this policy, D1-D9 and BCH progression remain blocked.
