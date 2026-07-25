# GPUbnb Host Desktop — Secure Release Gates

This document defines the minimum conditions for shipping GPUbnb Host Desktop. A release must fail closed when any required condition is missing.

## 1. Source and dependency integrity

- The release commit is reviewed and reachable from the protected default branch.
- JavaScript and Rust lockfiles are committed and used by the build.
- Production dependency audits report no high or critical vulnerability.
- GitHub Actions dependencies are pinned to immutable commits before a public release.
- The build records the source commit, runner platform and resolved lockfile digest.

## 2. Quality gates

Every supported platform must pass:

- TypeScript type checking;
- production frontend build;
- Rust tests for all targets;
- Clippy with warnings treated as errors;
- native desktop compilation;
- native installer generation;
- installer extension verification.

Expected development artifacts:

- Windows x64: NSIS `.exe`;
- Linux x64: Debian `.deb`;
- macOS arm64: `.dmg`.

A successful binary build without the expected installer is a failed release.

## 3. Security behavior

- Native diagnostics are bounded by timeouts and output-size limits.
- Missing, malformed or unavailable evidence produces a not-ready result.
- GPU readiness requires a detected NVIDIA GPU, a reachable Docker daemon, the NVIDIA runtime and the required isolation backend.
- Development-only payment bypasses must remain disabled in production.
- Container images used for diagnostics or rentals must be referenced by immutable digest in production.
- Secrets and long-lived tokens must never be written to application logs or plaintext configuration files.

## 4. Installer trust

Development installers are short-lived test artifacts and must display or include an unsigned-development warning.

A public release additionally requires:

- Windows Authenticode signing from an approved certificate;
- Apple Developer ID signing and notarization;
- an approved Linux package signing policy;
- SHA-256 manifests;
- software bill of materials;
- build provenance or attestations;
- verification of signatures before publication;
- rollback instructions and a previous known-good version.

Unsigned installers must never be published as a production release.

## 5. User-experience gates

Before public availability, a clean machine test must verify that a user can:

1. download the correct installer;
2. install without a terminal;
3. launch GPUbnb Host;
4. authenticate through the browser pairing flow;
5. detect the GPU and required runtime automatically;
6. understand every blocking diagnostic in plain language;
7. recover from common configuration failures without losing account state;
8. publish availability and pricing only after all security checks pass.

Errors must identify the failed prerequisite and a safe next action. The application must never present a host as ready when verification is incomplete.

## 6. Operational gates

The following scenarios require automated or documented verification:

- network interruption during pairing;
- Docker daemon unavailable;
- unsupported or missing NVIDIA driver;
- unavailable NVIDIA container runtime;
- diagnostic command timeout;
- host application restart;
- operating-system restart;
- interrupted upgrade and rollback;
- corrupted local configuration;
- expired or revoked pairing credentials.

## 7. Merge rule

The host-onboarding pull request may be merged only when all required CI checks are successful and no known blocker prevents the supported development installers from being produced.

A green development build does not by itself authorize public distribution. Signing, notarization, provenance, clean-machine installation tests and an approved release workflow remain mandatory.