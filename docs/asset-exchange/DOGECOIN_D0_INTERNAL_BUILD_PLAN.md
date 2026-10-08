# Dogecoin D0 Internal Reproducible Build Plan

Status: EXECUTABLE QUALIFICATION HARNESS / NO SETTLEMENT ACTIVATION / NO BINARY EXECUTION

## Purpose

This gate attempts an independent reproduction of the Dogecoin Core v1.14.9 Linux x86_64 release artifact after upstream prebuilt signer provenance failed gpu.k.p2p D0 policy.

It does not execute Dogecoin, start a node, use Mainnet, use real funds, or promote any asset capability.

## Pins

- Dogecoin source commit: `e0a1c157791544e818c901bd9341896965afbf9d`
- Gitian builder commit: `41c325d2f14147e8028fce9a5edd26e7adad30a4`
- LIEF wheel SHA-256: `c848aadac0816268aeb9dde7cefdb54bf24f78e664a19e97e74c92d3be1bb147`
- observed official Linux x86_64 SHA-256: `4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8`
- Ubuntu Focal container image: resolved at execution time and immediately pinned by immutable RepoDigest in each replica's evidence.

## Build design

Two independent GitHub-hosted runners build the artifact without shared build caches.

Each runner:

1. checks out the exact Dogecoin source commit;
2. checks out the exact Gitian builder commit;
3. downloads the exact LIEF input and verifies its SHA-256;
4. records the upstream Gitian Linux descriptor;
5. derives a reduced descriptor that keeps i686 and x86_64 only, preserving i686 as the source-dist host while omitting ARM build work;
6. pins the pulled Ubuntu Focal base image by immutable Docker RepoDigest;
7. creates a Focal Gitian Docker base;
8. builds using Dogecoin's depends system and Gitian logic;
9. runs the upstream descriptor's check-security/check-symbols steps;
10. records the x86_64 tarball and build evidence without executing any produced binary.

## Comparison gate

The compare job fails closed unless:

- both build artifacts exist;
- both SHA-256 values are identical;
- the hash equals the observed official release hash;
- both replicas report the same source commit;
- both replicas report the same Gitian builder commit;
- both replicas report the same Ubuntu Focal RepoDigest;
- neither evidence record claims binary execution.

The verifier inspects the tar archive without extracting/executing it, records its members, creates an SPDX 2.3 evidence document and creates a gpu.k.p2p provenance record.

GitHub/Sigstore attestations are produced for the internally reproduced artifact and SPDX evidence when the comparison gate passes.

## Trust boundary

A successful internal reproduction is strong evidence that the observed release bytes are derivable from the pinned upstream source/build process.

It does NOT repair or replace the upstream signer provenance automatically.

Therefore even on success:

- upstream prebuilt signer provenance remains BLOCKED;
- overall Dogecoin D0 remains `BLOCKED_PENDING_TRUST_POLICY_REVIEW`;
- D1-D9 do not start automatically;
- Dogecoin remains MARKETPLACE_ONLY;
- automaticSettlementSupported remains false;
- settlement route remains null;
- BCH does not start under strict STOP-ON-RED ordering.

Any decision to accept gpu.k.p2p internal reproducible provenance as a substitute trust root requires a separate reviewed security decision.
