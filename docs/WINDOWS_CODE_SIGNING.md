# Windows code signing for GPUbnb Host

## Goal

A promoted Windows GPUbnb Host release should be verifiably signed before publication. Code signing complements, rather than replaces, the existing immutable release tag, exact source commit, SHA-256 checksums and independent post-publication verification.

## Trust boundary

GPUbnb should use a managed signing service or other protected signing environment. No private signing key, certificate archive, password or equivalent secret may be committed to this repository.

The intended release order is:

1. build the exact Agent and Host tunnel from the release commit;
2. build the Tauri Host executable without bundling;
3. sign the Host executable and Windows sidecars;
4. verify every pre-bundle executable;
5. bundle the already-signed payload into the NSIS installer;
6. sign the final installer;
7. verify the final installer again;
8. only then calculate SHA-256 values and publish the immutable candidate;
9. independently verify the published candidate before moving the promoted release alias.

This ordering ensures hashes describe the final signed bytes rather than a pre-signing intermediate.

## Fail-closed policy

Development and pre-qualification candidates may remain unsigned while external signing infrastructure is not provisioned. That state must be explicit.

Once Windows signing is marked as required for promoted releases, the workflow must fail if:

- the signing provider is unavailable;
- authentication to the signing provider fails;
- any expected executable cannot be signed;
- any expected executable has no Authenticode signer;
- Windows reports a non-valid Authenticode signature;
- the final installer cannot be verified after signing.

There is no warn-and-continue path once signing is required.

## Files that must be signed

At minimum:

- `gpubnb-agent.exe`;
- `gpubnb-host-tunnel.exe`;
- the compiled `gpubnb-host-desktop.exe`;
- the final `gpubnb-host-windows-x64.exe` installer.

The portable Windows archive must be created only after executable payloads are signed so its contents remain individually verifiable.

## Verification

`scripts/verify-windows-authenticode.ps1` is the repository-side verifier. When invoked with `-Required`, every supplied file must have a valid Authenticode signature.

SHA-256 remains mandatory and is computed after signing. A valid signature does not waive exact `build-info.buildCommit` matching, installer smoke tests, release provenance checks or physical Windows qualification.

## Update policy

Unattended updates must not be enabled merely because signing support exists. They require a promoted release channel where Windows signing is mandatory and independently verified.

## Incident and rollback rule

If signing infrastructure is unavailable or a signature cannot be validated, do not publish a temporarily unsigned promoted replacement. Keep the last verified promoted release and investigate the signing failure. Rollback must target an immutable release whose source commit, hashes and Authenticode status are all known.
