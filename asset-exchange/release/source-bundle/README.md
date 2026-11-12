# Asset Exchange Source Audit Bundle

Status: PRE-RELEASE AUDIT ARTIFACT / NOT A RUNTIME PACKAGE / NO MAINNET AUTHORIZATION

This bundle gives reviewers an exact, reproducible snapshot of the Asset Exchange security boundary without including GPUbnb Core.

Included scope:
- `asset-exchange/**`;
- `docs/asset-exchange/**`;
- dedicated `.github/workflows/asset-exchange-*.yml`;
- the exact `.github/workflows/workspace-reliability.yml` manual caller;
- generated `SOURCE_BUNDLE_INFO.json`.

Excluded:
- GPUbnb Core application/runtime files;
- other root/general CI workflows;
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

The verifier also requires a checkout retaining the expected source Git object.
It independently verifies that the expected commit has the expected tree, then
compares the complete scoped file set and every blob byte to that object. A
self-consistent rewritten archive/SBOM or omitted source file is rejected.
Archive entries are bounded (10000 entries, 4 MiB per file, 32 MiB total), links
are forbidden, and no archive member is extracted by the verifier. The declared
scope and source epoch must agree with the exact build inputs. The v1 archive
format/name is retained; historical bundles use their original pinned verifier.

This scope contains the DOGE laboratory, recovery, signer policy, watcher code
and review documents. It excludes root Cargo files, Rust vendor sources and
GPUbnb Core. The separately pinned Rust PR must be reviewed with its own source
and test evidence; this archive does not certify that graph or the whole app.

This is a source/audit SBOM. It does NOT replace future runtime/container/package dependency SBOMs.
