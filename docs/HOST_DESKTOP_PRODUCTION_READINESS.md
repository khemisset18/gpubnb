# GPUbnb Host Desktop — Production Readiness Gate

Status: **NOT READY TO MERGE**

This document is the authoritative merge gate for pull request #11. The pull request must remain a draft until every mandatory item below has objective evidence.

## Non-negotiable security principles

- Fail closed on every missing, stale, ambiguous, or failed check.
- Never expose the host desktop, home directory, browser profile, credentials, clipboard, devices, sockets, or session tokens to a renter.
- Run privileged operations in a minimal signed service, never in the webview UI.
- Treat renter workloads, images, commands, files, and network traffic as hostile.
- Use ephemeral credentials and destroy the renter workspace after every rental.
- Do not start a rental until an optional miner has stopped cleanly and GPU ownership is verified.
- Do not claim compatibility from OS and CPU architecture alone.

## Current verified blockers

1. Native compatibility probes are not implemented. Hyper-V, Virtualization Framework, and KVM availability are not actually verified.
2. Setup actions are placeholders and do not install, configure, attest, or persist the required protections.
3. Account pairing has configuration metadata only; there is no complete device-code exchange, token validation, secure token storage, refresh, revocation, or replay protection.
4. There is no signed privileged host service.
5. There is no production workspace provisioning and destruction implementation.
6. There is no renter network policy enforcement.
7. There is no secure GPU handoff or miner process supervisor.
8. There is no emergency-stop implementation connected to real workloads and credential revocation.
9. There are no signed installers or update-signing process.
10. Multi-OS CI has not produced successful evidence because GitHub-hosted jobs are blocked at account level.

## Required architecture

### UI process

- Unprivileged Tauri UI.
- No shell execution capability.
- No broad filesystem capability.
- No secrets in localStorage.
- Strict CSP and explicit allowlists.
- Communicates with the host service through an authenticated local channel.

### Host service

- Separate signed binary with the minimum OS privileges.
- Authenticated local IPC with per-installation identity and anti-replay protection.
- Explicit command allowlist and schema validation.
- Durable state machine with crash recovery and an append-only security audit log.
- No arbitrary command, path, environment variable, URL, or image supplied directly by the UI or renter.

### Workspace runtime

- Windows: certified Hyper-V VM or an equivalently isolated backend. WSL alone must not be assumed sufficient.
- macOS: Virtualization.framework VM with explicit device and filesystem policy.
- Linux: KVM VM or a separately reviewed hardened isolation design.
- Read-only trusted base images verified by digest and signature.
- Ephemeral writable disk encrypted where supported and destroyed after use.
- No host home-directory mounts.
- No host Docker socket, display socket, SSH agent, cloud credentials, or package-manager credentials.
- Default-deny network policy with narrowly scoped egress rules.

## Resource orchestration state machine

Allowed high-level sequence:

`OFFLINE -> IDLE -> MINING -> STOPPING_MINER -> RENTAL_PREPARING -> RENTAL -> CLEANING -> IDLE`

Mandatory failure behavior:

- Any failed invariant transitions to `QUARANTINED` or `EMERGENCY_STOPPED`.
- A miner stop timeout blocks the rental.
- A failed GPU reset blocks the rental.
- A failed workspace cleanup blocks all later rentals.
- A stale heartbeat revokes renter credentials and stops the workspace.
- Restarting the application must reconstruct the true state from the service, not assume `IDLE`.

## Mandatory implementation evidence

### Build and dependency integrity

- Committed lockfiles for Rust and Node dependencies.
- Reproducible CI installation (`cargo --locked`, `npm ci`).
- Dependency vulnerability review.
- License review.
- Pinned or reviewed CI actions.
- Release artifacts include provenance, hashes, and signatures.

### Tests

- Rust unit tests for every state transition and rejection path.
- Property/state-machine tests for invalid transition sequences.
- IPC authentication and authorization tests.
- Pairing replay, expiry, revocation, and malformed-input tests.
- Workspace escape and host-mount negative tests.
- Network default-deny tests.
- Miner stop timeout and crash tests.
- Power-loss and process-crash recovery tests.
- Installer/uninstaller tests on Windows, macOS, and Linux.
- End-to-end test proving a renter cannot read a seeded host secret.

### Operational readiness

- Versioned migration and rollback plan.
- Key rotation and compromised-release response plan.
- Security logging without secrets or renter payloads.
- Rate limits and abuse controls.
- Privacy and retention policy.
- Incident runbooks for compromised host, malicious renter, leaked signing key, and failed cleanup.

## Merge rule

Pull request #11 may leave draft status only when:

1. every current blocker has an implementation;
2. all mandatory tests pass on supported operating systems;
3. installers and updates are signed;
4. a security review finds no unresolved critical or high-severity issue;
5. the exact release candidate is tested, hashed, and archived;
6. rollback and emergency-stop drills have been completed.

Until then, the application may be used only as a development foundation and UI prototype. It must not accept real renters or advertise a host as secure.
