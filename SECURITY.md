# Security Policy

GPUbnb treats the control plane, host agent, Windows native runtime, release pipeline, renter isolation and billing authority as security-sensitive components.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in a public issue.

Use GitHub's private vulnerability reporting / Security Advisory flow for this repository when available. If private reporting is unavailable, contact the repository maintainer privately before publishing technical details.

Include:
- affected commit or release;
- affected component and operating system;
- reproduction steps;
- expected and observed trust boundary;
- whether credentials, renter/provider isolation, billing authority, signing, update integrity or remote code execution may be affected.

## Security invariants

Changes must remain fail-closed. In particular:
- an unqualified runtime must never become bookable;
- a Windows-native session must never fall back to the container/Selkies runtime, or vice versa;
- provider desktop/files/credentials must remain outside the renter boundary;
- exact leased GPU identity must be preserved through capture and encode;
- workflow and release artifacts must not bypass signature, provenance or cleanup checks;
- cleanup failure is a security failure, not a successful stop.

Security fixes should include regression tests whenever practical.
