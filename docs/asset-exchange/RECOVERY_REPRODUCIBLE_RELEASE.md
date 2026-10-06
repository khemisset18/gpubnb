# Recovery Tool Reproducible Packaging

Status: PRE-MAINNET / NO REAL FUNDS.

The standalone recovery tool is packaged so users can retain a verifiable recovery path even if gpu.k.p2p, its API, or its frontend is unavailable.

## Build properties

The artifact is built twice from the same source commit. The build normalizes:
- explicit file allow-list;
- file modes;
- tar order;
- uid/gid;
- mtimes from the commit timestamp;
- gzip timestamps.

The two archives, SBOMs, and checksum files must be byte-for-byte identical.

## Contents

Only the recovery CLI, its recovery modules, the three required Asset Exchange core helpers, build metadata, and recovery documentation are included.

The artifact excludes API/server/database code, node_modules, GPUbnb Core code, seeds, private keys, wallet passwords, and runtime secrets.

## Supply-chain evidence

The dedicated workflow creates:
- SHA-256 checksums;
- SPDX 2.3 SBOM;
- GitHub/Sigstore SLSA build-provenance attestation;
- SBOM attestation;
- uploaded evidence bundle.

The attestation action is pinned by immutable commit SHA.

## Local rebuild

```bash
SOURCE_SHA="$(git rev-parse HEAD)"
SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)"
asset-exchange/recovery/release/build-reproducible.sh /tmp/recovery-build "$SOURCE_SHA" "$SOURCE_DATE_EPOCH"
asset-exchange/recovery/release/verify-artifact.sh /tmp/recovery-build/dist
```

A consumer should verify:
1. `SHA256SUMS`;
2. the tar file list;
3. the SPDX SBOM;
4. the GitHub artifact provenance attestation against repository `khemisset18/gpubnb`;
5. the SBOM attestation;
6. the attested source commit.

Generating an attestation is not sufficient by itself; consumers must verify it.

This workflow does not publish a GitHub Release, merge to main, authorize Mainnet, or handle user private keys.
