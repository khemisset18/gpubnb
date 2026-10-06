# Asset Exchange Source Audit Bundle

Status: PRE-RELEASE AUDIT ARTIFACT / NOT A RUNTIME PACKAGE / NO MAINNET AUTHORIZATION

This bundle gives reviewers an exact, reproducible snapshot of the Asset Exchange security boundary without including GPUbnb Core.

Included scope:
- `asset-exchange/**`;
- `docs/asset-exchange/**`;
- dedicated `.github/workflows/asset-exchange-*.yml`;
- generated `SOURCE_BUNDLE_INFO.json`.

Excluded:
- GPUbnb Core application/runtime files;
- root/general CI workflows;
- node_modules;
- secrets;
- untracked working-tree files.

The bundle is built from Git objects at one exact commit SHA, twice, and the two archives/SBOMs/checksum files must match byte-for-byte.

The SPDX 2.3 document includes:
- SHA-1 and SHA-256 for every file;
- package verification code;
- SHA-256 of the source archive;
- exact source commit;
- exact Git tree.

A separate consumer job revalidates the archive contents and verifies GitHub/Sigstore provenance and SPDX attestation.

This is a source/audit SBOM. It does NOT replace future runtime/container/package dependency SBOMs.
